// Finds the ads that the podcast host stitches into the episode stream.
//
// Browsers are served the MP3 with pre-, mid- and post-roll ads inserted, but the
// ID3 chapter times (and the iTunes duration) refer to the ad-free episode. On
// episodes since ~Oct 2024, the show's MP3 frames have the "original" header bit
// set and the ad frames don't, and everything is CBR 128 kbps / 44.1 kHz
// (exactly 16000 bytes per second). So tiny Range requests at known times tell
// us whether that moment is show or ad, without downloading the file.
"use strict";

const Ads = (() => {
  const BYTES_PER_SEC = 16000;
  const STEP = 30;          // seconds between coarse samples (ad breaks are 40 s+)
  const PRECISION = 0.05;   // seconds; one MP3 frame is ~0.026 s
  const CONCURRENCY = 6;
  const PROBE_BYTES = 1500; // a few MP3 frames

  // true = show audio, false = ad, null = not the expected MP3 format.
  async function kindAt(url, tagSize, t, signal) {
    const start = tagSize + Math.floor(t * BYTES_PER_SEC);
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${start + PROBE_BYTES - 1}` }, signal });
    if (resp.status !== 206) throw new Error(`range request failed (HTTP ${resp.status})`);
    const b = new Uint8Array(await resp.arrayBuffer());
    for (let i = 0; i + 4 < b.length; i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      // Expect MPEG-1 Layer III, 128 kbps, 44.1 kHz.
      if ((b[i + 1] & 0x1e) !== 0x1a || b[i + 2] >> 4 !== 9 || ((b[i + 2] >> 2) & 3) !== 0) continue;
      // Confirm the next frame header so a stray 0xFF in audio data isn't mistaken for a frame.
      const next = i + 417 + ((b[i + 2] >> 1) & 1);
      if (next + 1 < b.length && !(b[next] === 0xff && (b[next + 1] & 0xe0) === 0xe0)) continue;
      return Boolean(b[i + 3] & 0x04);
    }
    return null;
  }

  async function mapLimit(items, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return out;
  }

  // Probes needed to binary-search one STEP-wide interval down to PRECISION.
  const EDGE_PROBES = Math.ceil(Math.log2(STEP / PRECISION));
  const TYPICAL_EDGES = 6; // pre-, mid- and post-roll: estimate until the scan has run

  // Returns ad ranges [{start, end}] in file seconds ([] = no ads), or null if
  // they can't be detected (older episodes don't mark show frames).
  // onProgress(done, total) is called after every probe; `total` is exact once
  // the coarse scan has found the edges, an estimate before that.
  async function detect(url, tagSize, fileDuration, signal, onProgress = () => {}) {
    const last = fileDuration - 0.1;
    const times = [];
    for (let t = 0.5; t < last; t += STEP) times.push(t);
    times.push(last);

    let done = 0;
    let total = 3 + times.length + TYPICAL_EDGES * EDGE_PROBES;
    const probe = async (t) => {
      const k = await kindAt(url, tagSize, t, signal);
      onProgress(++done, total);
      return k;
    };

    // Quick check: older episodes have no frames marked as show audio, so stop early.
    const spot = await mapLimit([0.3, 0.5, 0.7].map((x) => x * fileDuration), probe);
    if (!spot.includes(true)) return null;

    const kinds = await mapLimit(times, probe);
    if (kinds.includes(null) || !kinds.includes(true)) return null;
    if (!kinds.includes(false)) return [];

    // Binary-search each show/ad transition down to about one frame.
    const edgeIdx = [];
    for (let i = 1; i < times.length; i++) if (kinds[i] !== kinds[i - 1]) edgeIdx.push(i);
    total = done + edgeIdx.length * EDGE_PROBES;
    onProgress(done, total);
    const edges = await Promise.all(edgeIdx.map(async (i) => {
      let lo = times[i - 1];
      let hi = times[i];
      const loKind = kinds[i - 1];
      while (hi - lo > PRECISION) {
        const mid = (lo + hi) / 2;
        const k = await probe(mid);
        if (k === null) throw new Error("unexpected MP3 frame");
        if (k === loKind) lo = mid;
        else hi = mid;
      }
      return { t: hi, adStarts: loKind === true };
    }));

    const ads = [];
    let open = kinds[0] === false ? 0 : null;
    for (const e of edges) {
      if (e.adStarts) open = e.t;
      else if (open !== null) {
        ads.push({ start: open, end: e.t });
        open = null;
      }
    }
    if (open !== null) ads.push({ start: open, end: fileDuration });
    return ads;
  }

  // ---------- Megaphone shows: ad maps precomputed by tools/admap.py ----------
  //
  // admaps/<guid>.json lists the show audio's segments (in show frames) and the
  // CRC-32 of every `stride`-th show frame. Ads in our copy can only sit between
  // segments, so for each segment we Range-fetch a few frames where it should
  // start, look their CRCs up, and learn exactly how many seconds of ads precede
  // it (the "offset"). A probe that matches nothing is inside an ad.

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  // Same as Python's zlib.crc32.
  function crc32(b, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const MP3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const MP3_RATES = [44100, 48000, 32000];

  // Size of the MPEG-1 Layer III frame starting at b[i], or 0 if there isn't one.
  function frameSize(b, i) {
    if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xfa) return 0;
    const bi = b[i + 2] >> 4;
    const si = (b[i + 2] >> 2) & 3;
    if (bi === 0 || bi === 15 || si === 3) return 0;
    return Math.floor((144 * MP3_KBPS[bi] * 1000) / MP3_RATES[si]) + ((b[i + 2] >> 1) & 1);
  }

  async function fetchMap(guid, signal) {
    const name = guid.replace(/[^A-Za-z0-9_-]/g, "_");
    const resp = await fetch(`admaps/${name}.json`, { signal });
    if (!resp.ok) return null; // not built (yet) for this episode
    const m = await resp.json();
    const raw = Uint8Array.from(atob(m.hashes), (ch) => ch.charCodeAt(0));
    const view = new DataView(raw.buffer);
    const lookup = new Map();
    for (let i = 0; i * 4 < raw.length; i++) {
      const h = view.getUint32(i * 4, true);
      if (h) lookup.set(h, i * m.stride);
    }
    return { ...m, lookup };
  }

  // Detect ads using a precomputed map. Same contract as detect(): ad ranges in
  // file seconds, [] for none, or null if there's no map / it doesn't fit this copy.
  async function detectMapped(guid, url, tagSize, fileDuration, signal, onProgress = () => {}) {
    const map = await fetchMap(guid, signal);
    if (!map) return null;
    const bps = (map.kbps * 1000) / 8;
    const fsec = map.spf / map.rate; // seconds per frame
    const span = (2 * map.stride + 2) * Math.ceil((144 * map.kbps * 1000) / map.rate + 1);
    const showEnd = map.frames * fsec;

    let done = 0;
    let total = map.segs.length + 8;
    // Offset (seconds of ads before this point) of the show audio at file time x,
    // or null if nothing there matches the show (an ad, or an unusable spot).
    const probe = async (x) => {
      const startByte = tagSize + Math.max(0, Math.floor(x * bps));
      const resp = await fetch(url, { headers: { Range: `bytes=${startByte}-${startByte + span - 1}` }, signal });
      if (resp.status !== 206) throw new Error(`range request failed (HTTP ${resp.status})`);
      const b = new Uint8Array(await resp.arrayBuffer());
      onProgress(++done, Math.max(total, done + 1));
      // Find a frame boundary (two consecutive headers), then walk the frames.
      let i = 0;
      while (i < b.length && !(frameSize(b, i) && frameSize(b, i + frameSize(b, i)))) i++;
      for (let n; (n = frameSize(b, i)) && i + n <= b.length; i += n) {
        const k = map.lookup.get(crc32(b, i, i + n));
        if (k !== undefined) return (startByte + i - tagSize) / bps - k * fsec;
      }
      return null;
    };

    const ads = [];
    const addAd = (start, end) => { if (end - start > 0.3) ads.push({ start, end }); };
    let offset = 0;
    let goodAt = 0; // a file time known to have offset `offset` (or the start of the file)
    const same = (o) => o !== null && Math.abs(o - offset) < 0.15;

    for (const [s, len] of map.segs) {
      const segStart = s * fsec;
      const segLen = len * fsec;
      if (segLen < 2) continue; // too short to probe reliably; any ad here shows up at the next segment
      const p = segStart + offset + 0.3;
      const o = await probe(p);
      if (same(o)) { goodAt = p; continue; }
      if (o !== null && o > offset) {
        // Ads somewhere before p but not at a known boundary: binary-search for where the offset changes.
        let lo = goodAt;
        let hi = p;
        while (hi - lo > 0.1) {
          const mid = (lo + hi) / 2;
          if (same(await probe(mid))) lo = mid;
          else hi = mid;
        }
        addAd(lo, lo + (o - offset));
        offset = o;
        goodAt = p;
        continue;
      }
      // Inside an ad (or a ruined spot): look further on, a few probes at a time.
      let found = null;
      for (let base = p + 5; found === null && base < p + 900 && base < fileDuration; base += 60) {
        const xs = Array.from({ length: 6 }, (_, k) => base + k * 10).filter((x) => x < fileDuration);
        total += xs.length;
        const res = await Promise.all(xs.map(probe));
        const k = res.findIndex((r) => r !== null && r >= offset - 0.15);
        if (k >= 0) found = { x: xs[k], o: res[k] };
      }
      if (!found) return null; // the show never resumed: map doesn't fit this copy
      addAd(segStart + offset, segStart + found.o);
      offset = Math.max(offset, found.o);
      goodAt = found.x;
    }

    // Everything after the last show frame is post-roll. The map must account for the whole file.
    const end = showEnd + offset;
    if (fileDuration - end < -2) return null;
    addAd(end, fileDuration);
    if (Math.abs(fileDuration - (showEnd + ads.reduce((t, a) => t + a.end - a.start, 0))) > 2) return null;
    return ads;
  }

  return { detect, detectMapped };
})();
