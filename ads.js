// Finds the ads that the podcast host stitches into the episode stream.
//
// Browsers are served the MP3 with pre-, mid- and post-roll ads inserted, but the
// ID3 chapter times (and the iTunes duration) refer to the ad-free episode. On
// episodes since ~Oct 2024, the show's MP3 frames have the "original" header bit
// set and the ad frames don't, and everything is CBR 128 kbps / 44.1 kHz
// (exactly 16000 bytes per second). So tiny Range requests at known times tell
// us whether that moment is show or ad, without downloading the file.
"use strict";

// Range requests use cache: "no-store": Chrome's HTTP cache lets only one request
// at a time use a given URL (a "cache lock"), which serialised every probe and
// made the first one wait for the <audio> element's own download of the file.
const Ads = (() => {
  const BYTES_PER_SEC = 16000;
  const STEP = 30;          // seconds between coarse samples (ad breaks are 40 s+)
  const PRECISION = 0.05;   // seconds; one MP3 frame is ~0.026 s
  const CONCURRENCY = 16;   // parallel Range requests (all to one HTTP/2 host)
  const MAPPED_CONCURRENCY = 16;
  const PROBE_BYTES = 1500; // a few MP3 frames

  // true = show audio, false = ad, null = not the expected MP3 format.
  async function kindAt(url, tagSize, t, signal) {
    const start = tagSize + Math.floor(t * BYTES_PER_SEC);
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${start + PROBE_BYTES - 1}` }, cache: "no-store", signal });
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

  // Probes needed to search one STEP-wide interval down to PRECISION, testing
  // SPLIT - 1 points in parallel per round (so each round is one round-trip).
  // (Omny serves HTTP/1.1, so the browser opens at most 6 connections and plain
  // binary search, one probe per edge per round, keeps them all busy.)
  const SPLIT = 2;
  const EDGE_ROUNDS = Math.ceil(Math.log(STEP / PRECISION) / Math.log(SPLIT));
  const EDGE_PROBES = EDGE_ROUNDS * (SPLIT - 1);
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

    // Narrow each show/ad transition down to about one frame, SPLIT-ary search.
    const edgeIdx = [];
    for (let i = 1; i < times.length; i++) if (kinds[i] !== kinds[i - 1]) edgeIdx.push(i);
    total = done + edgeIdx.length * EDGE_PROBES;
    onProgress(done, total);
    const edges = await Promise.all(edgeIdx.map(async (i) => {
      let lo = times[i - 1];
      let hi = times[i];
      const loKind = kinds[i - 1];
      while (hi - lo > PRECISION) {
        const pts = Array.from({ length: SPLIT - 1 }, (_, k) => lo + ((hi - lo) * (k + 1)) / SPLIT);
        const ks = await Promise.all(pts.map(probe));
        if (ks.includes(null)) throw new Error("unexpected MP3 frame");
        // The edge lies after the last point that still matches lo's kind.
        let last = -1;
        ks.forEach((k, j) => { if (k === loKind) last = j; });
        const newLo = last >= 0 ? pts[last] : lo;
        hi = last + 1 < pts.length ? pts[last + 1] : hi;
        lo = newLo;
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

  // Fetched once per episode; prefetchMap() lets app.js start this while the audio's redirects resolve.
  const mapCache = new Map();
  function prefetchMap(guid) {
    if (!mapCache.has(guid)) mapCache.set(guid, fetchMap(guid).catch(() => { mapCache.delete(guid); return null; }));
    return mapCache.get(guid);
  }
  // Drop a cached "no map" so the next prefetchMap() asks the server again (after a requested build).
  const forgetMap = (guid) => mapCache.delete(guid);

  async function fetchMap(guid) {
    const name = guid.replace(/[^A-Za-z0-9_-]/g, "_");
    const resp = await fetch(`admaps/${name}.json`, { cache: "no-cache" }); // revalidate: a map may have been added since
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
    const map = await prefetchMap(guid);
    if (!map) return null;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const bps = (map.kbps * 1000) / 8;
    const fsec = map.spf / map.rate; // seconds per frame
    const span = (2 * map.stride + 2) * Math.ceil((144 * map.kbps * 1000) / map.rate + 1);
    const showEnd = map.frames * fsec;

    let done = 0;
    let total = map.segs.length + 8;
    // Offset (seconds of ads before this point) of the show audio at file time x,
    // or null if nothing there matches the show (an ad, or an unusable spot).
    // With `withShowTime`, returns {o, t} where t is the show time it matched.
    const probe = async (x, withShowTime = false) => {
      const startByte = tagSize + Math.max(0, Math.floor(x * bps));
      const resp = await fetch(url, { headers: { Range: `bytes=${startByte}-${startByte + span - 1}` }, cache: "no-store", signal });
      if (resp.status !== 206) throw new Error(`range request failed (HTTP ${resp.status})`);
      const b = new Uint8Array(await resp.arrayBuffer());
      onProgress(++done, Math.max(total, done + 1));
      // Find a frame boundary (two consecutive headers), then walk the frames.
      let i = 0;
      while (i < b.length && !(frameSize(b, i) && frameSize(b, i + frameSize(b, i)))) i++;
      for (let n; (n = frameSize(b, i)) && i + n <= b.length; i += n) {
        const k = map.lookup.get(crc32(b, i, i + n));
        if (k === undefined) continue;
        const o = (startByte + i - tagSize) / bps - k * fsec;
        return withShowTime ? { o, t: k * fsec } : o;
      }
      return null;
    };

    const fast = await detectParallel(map, fsec, showEnd, fileDuration, probe, (n) => { total = n; });
    if (fast) return fast;
    return detectSequential(map, fsec, showEnd, fileDuration, probe, (n) => { total += n; });
  }

  // Fast path: ads can only sit at segment boundaries, and the total ad time is known
  // (file length minus show length), so every segment's offset lies in [0, adTotal].
  // Probe the middle of each segment at a spread of candidate offsets, all in
  // parallel; a hit inside the right segment gives that segment's exact offset.
  // Returns null if anything doesn't add up (then the sequential search runs).
  async function detectParallel(map, fsec, showEnd, fileDuration, probe, setTotal) {
    const adTotal = fileDuration - showEnd;
    if (adTotal < -2) return null;
    const segs = map.segs
      .map(([s, len]) => ({ start: s * fsec, len: len * fsec, offset: null }))
      .filter((g) => g.len >= 2); // too short to probe; an ad there is placed at the next segment
    // Candidate offsets per segment, spaced so the probe windows (±40% of the segment) overlap.
    const tasks = [];
    segs.forEach((g, si) => {
      const step = g.len * 0.8;
      const n = Math.max(1, Math.ceil(Math.max(0, adTotal) / step) + 1);
      for (let j = 0; j < n; j++) tasks.push({ si, j, guess: Math.min(Math.max(0, adTotal), j * step) });
    });
    tasks.sort((a, b) => a.j - b.j || a.si - b.si); // first guess of every segment first
    setTotal(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const { si, guess } = tasks[next++];
        const g = segs[si];
        if (g.offset !== null) continue; // already found
        const r = await probe(g.start + g.len / 2 + guess, true);
        // Accept only a hit inside this segment (a probe can land in a neighbouring one).
        if (r && r.t >= g.start - 0.05 && r.t < g.start + g.len + 0.05 && g.offset === null) g.offset = r.o;
      }
    };
    await Promise.all(Array.from({ length: MAPPED_CONCURRENCY }, worker));

    // A segment no probe matched isn't the show in this copy. That happens when every
    // copy the map was built from got the same promo there (so it looked like show)
    // and this copy got something else: treat it as part of the surrounding ad break.
    const ads = [];
    let prev = 0;
    let adFrom = null; // file time where an unmatched stretch began
    let unmatched = 0; // map seconds not present in this copy
    for (const g of segs) {
      if (g.offset === null) {
        if (adFrom === null) adFrom = g.start + prev;
        unmatched += g.len;
        continue;
      }
      if (g.offset < prev - unmatched - 0.15) return null;
      const start = adFrom ?? g.start + prev;
      const end = g.start + g.offset;
      if (end - start > 0.3) ads.push({ start, end });
      adFrom = null;
      prev = Math.max(prev, g.offset);
    }
    if (unmatched > 180) return null; // too much missing: the map doesn't fit this copy
    const end = adFrom ?? showEnd + prev;
    if (fileDuration - end < -2) return null;
    if (fileDuration - end > 0.3) ads.push({ start: end, end: fileDuration });
    const adTime = ads.reduce((t, a) => t + a.end - a.start, 0);
    if (Math.abs(fileDuration - (showEnd - unmatched + adTime)) > 2) return null;
    return ads;
  }

  // Slow, careful path: walk the segments in order, one probe each, searching
  // whenever the offset changes somewhere unexpected.
  async function detectSequential(map, fsec, showEnd, fileDuration, probe, addTotal) {
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
        addTotal(xs.length);
        const res = await Promise.all(xs.map((x) => probe(x)));
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

  // ---------- comparing copies (Megaphone shows, Android app only) ----------
  //
  // Megaphone stitches different ads into the copy each User-Agent gets, but the show audio
  // is byte-identical in every copy. The Android app can fetch other copies with other
  // User-Agents (a web page can't set one), so the user's copy is compared with them using
  // small Range requests, never whole downloads (~1–2 MB per episode):
  //  1. Scan: every SCAN_SEC, compare a few hundred bytes of the user's copy with each other
  //     copy at the matching offset. They match while both are in the same show segment.
  //  2. Where a copy stops matching, search for the exact byte where they diverge (an ad
  //     starts in one of them).
  //  3. Realign: past the break the copies differ by an unknown number of bytes (their ad
  //     lengths differ). Read one contiguous block of the user's copy that must be show
  //     again, hash its MP3 frames, and read short chunks of the other copy spaced one block
  //     apart over every possible offset ("baby-step giant-step"): one chunk lands inside
  //     the block and its frames give the new offset.
  //  4. With the new offset, search for the first byte where they match again: the end of
  //     the user's ad (no ad if that's where they diverged, i.e. only the other copy had one).
  // An ad served identically to every copy at the same spot can't be seen (it looks like show).
  // Spacing of the coarse comparisons. A break is found if a sample lands in it or if the
  // copies' ads there differ in length (then the offset after it changes), so only a break
  // shorter than this with equally long ads in every copy can be missed. Each sample touches
  // a new part of every copy, and Megaphone takes 0.3–3 s to serve a part for the first time.
  const SCAN_SEC = 90;
  const CMP_BYTES = 512;      // bytes compared per probe
  const MAX_BREAK_SEC = 300;  // longest ad break looked for (also the post-roll limit)
  const BLOCK = 256 * 1024;   // contiguous block of the user's copy hashed when realigning
  const CHUNK = 2560;         // other-copy chunk (holds 3+ whole frames at 192 kbps)
  const WINDOW = 24 * 1024;   // searches stop at this size and read the window whole
  const SCAN_BATCH = 400;     // coarse comparisons per round: all at once (first reads are slow, see SCAN_SEC)
  const SEARCH_WAYS = 15;     // probes per round of the k-ary searches

  const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  // Frames in b: [{at, crc}] for every whole frame after the first confirmed header pair.
  function framesIn(b) {
    let i = 0;
    while (i < b.length && !(frameSize(b, i) && frameSize(b, i + frameSize(b, i)))) i++;
    const out = [];
    for (let n; (n = frameSize(b, i)) && i + n <= b.length; i += n) out.push({ at: i, crc: crc32(b, i, i + n) });
    return out;
  }

  // Smallest p in (lo, hi] with pred(p) true, given pred(lo) false and pred(hi) true. Stops
  // once the range is under `until` bytes (the caller reads that window whole).
  async function searchFirst(lo, hi, pred, count, until = 1) {
    while (hi - lo > until) {
      const xs = [...new Set(Array.from({ length: SEARCH_WAYS }, (_, i) => Math.floor(lo + ((hi - lo) * (i + 1)) / (SEARCH_WAYS + 1))))]
        .filter((x) => x > lo && x < hi);
      if (!xs.length) break;
      count(xs.length);
      const rs = await Promise.all(xs.map(pred));
      const k = rs.indexOf(true);
      if (k === -1) lo = xs[xs.length - 1];
      else { hi = xs[k]; if (k > 0) lo = xs[k - 1]; }
    }
    return hi;
  }

  // user / refs: {size, tagSize, read(start, len) => Uint8Array} for the user's copy and other
  // copies of the same episode. Same contract as detect(): ad ranges in file seconds, [] for
  // none, or null if the copies can't be lined up.
  async function detectCompare(userCopy, refs, fileDuration, onProgress = () => {}) {
    // The same spot of the user's copy is compared with every other copy: read it once.
    const memo = new Map();
    const user = {
      ...userCopy,
      read(start, len) {
        const key = `${start}:${len}`;
        if (!memo.has(key)) memo.set(key, userCopy.read(start, len));
        return memo.get(key);
      },
    };
    const head = await user.read(user.tagSize, 4096);
    const first = framesIn(head)[0];
    if (!first) return null;
    const bps = (MP3_KBPS[head[first.at + 2] >> 4] * 1000) / 8; // CBR: bytes per second
    const toSec = (byte) => (byte - user.tagSize) / bps;
    if (fileDuration == null) fileDuration = toSec(user.size); // not known yet (the app starts before the audio loads)
    if (Math.abs(toSec(user.size) - fileDuration) > Math.max(5, fileDuration * 0.02)) return null; // not CBR as assumed

    let done = 0;
    let total = Math.ceil((user.size - user.tagSize) / (SCAN_SEC * bps)) + 60;
    const count = (n) => { done += n; total = Math.max(total, done + 10); onProgress(done, total); };

    // Other copy r is at user position + offs[r] (they start together after the ID3 tag).
    let live = refs.map((r, i) => ({ r, i, off: r.tagSize - user.tagSize }));
    const eq = async (p, ref, off = ref.off, n = CMP_BYTES) => {
      if (p < user.tagSize || p + n > user.size || p + off < ref.r.tagSize || p + off + n > ref.r.size) return false;
      const [a, b] = await Promise.all([user.read(p, n), ref.r.read(p + off, n)]);
      return sameBytes(a, b);
    };

    // New offset of `ref` after a break that began at user position `div`, plus where the
    // user's copy is show again. null if no show follows within MAX_BREAK_SEC.
    async function realign(ref, div) {
      for (const t of [90, MAX_BREAK_SEC]) {
        const P = div + Math.floor(t * bps);
        if (P + BLOCK > user.size) break;
        const block = await user.read(P, BLOCK);
        count(1);
        const seen = new Map();
        for (const f of framesIn(block)) seen.set(f.crc, seen.has(f.crc) ? -1 : P + f.at); // repeated (e.g. silent) frames: unusable
        const step = BLOCK - 2 * CHUNK;
        const qs = [];
        for (let q = P + ref.off - Math.floor(t * bps); q < P + ref.off + MAX_BREAK_SEC * bps + BLOCK; q += step) {
          if (q >= ref.r.tagSize && q + CHUNK <= ref.r.size) qs.push(q);
        }
        count(qs.length);
        const chunks = await Promise.all(qs.map((q) => ref.r.read(q, CHUNK)));
        const votes = new Map(); // offset -> {n, at: first user position matched}
        chunks.forEach((b, j) => {
          for (const f of framesIn(b)) {
            const at = seen.get(f.crc);
            if (!(at > 0)) continue;
            const o = qs[j] + f.at - at;
            const v = votes.get(o) || { n: 0, at };
            votes.set(o, { n: v.n + 1, at: Math.min(v.at, at) });
          }
        });
        const best = [...votes].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].n - a[1].n)[0];
        if (!best) continue;
        const [off, { at: showAt }] = best;
        // Confirm with a byte comparison just past the block (if the file goes on that far).
        const check = P + BLOCK;
        if (check + 2048 <= user.size && check + off + 2048 <= ref.r.size && !(await eq(check, ref, off, 2048))) continue;
        // showAt is show in both copies; the user's ad ends somewhere in [div, showAt].
        const hi = await searchFirst(div - 1, showAt, (p) => eq(p, ref, off), count, WINDOW);
        // The ad ends just after the last differing byte in the window before hi.
        const from = Math.max(div, hi - WINDOW);
        const [a, b] = await Promise.all([user.read(from, hi - from), ref.r.read(from + off, hi - from)]);
        count(1);
        let i = a.length;
        while (i > 0 && a[i - 1] === b[i - 1]) i--;
        return { off, resume: from + i };
      }
      return null;
    }

    const ads = [];
    let pos = user.tagSize; // all live copies match here (or the user's copy starts with an ad)
    let atStart = true;
    while (live.length) {
      // Next coarse comparisons.
      const xs = atStart ? [pos] : Array.from({ length: SCAN_BATCH }, (_, i) => pos + Math.floor((i + 1) * SCAN_SEC * bps))
        .filter((x) => x + CMP_BYTES <= user.size);
      // Always compare the very end too: a post-roll shorter than SCAN_SEC can fall between samples.
      const last = user.size - CMP_BYTES;
      if (!atStart && last > pos && (!xs.length || xs[xs.length - 1] < last) && xs.length < SCAN_BATCH) xs.push(last);
      if (!xs.length) break;
      count(xs.length);
      const rs = await Promise.all(xs.map((x) => Promise.all(live.map((ref) => eq(x, ref)))));
      const k = rs.findIndex((row) => row.includes(false));
      if (k === -1) { pos = xs[xs.length - 1]; atStart = false; continue; }
      const lo = k === 0 ? pos : xs[k - 1];
      const hi = xs[k];
      const broken = live.filter((_, j) => !rs[k][j]);
      // Each diverging copy: exact divergence, then realign.
      const results = await Promise.all(broken.map(async (ref) => {
        let div = lo;
        if (!atStart && (await eq(lo, ref))) {
          // Last matching window start, then the first differing byte after it.
          const first = await searchFirst(lo, hi, async (p) => !(await eq(p, ref)), count, WINDOW);
          const from = Math.max(lo, first - WINDOW);
          const len = Math.min(first - from + CMP_BYTES, user.size - from, ref.r.size - from - ref.off);
          const [a, b] = await Promise.all([user.read(from, len), ref.r.read(from + ref.off, len)]);
          count(1);
          const i = a.findIndex((x, j) => x !== b[j]);
          div = from + (i >= 0 ? i : len);
        }
        return { ref, div, re: await realign(ref, div) };
      }));
      atStart = false;
      const start = Math.min(...results.map((x) => x.div));
      const ok = results.filter((x) => x.re);
      if (!ok.length) {
        // No show after the break: a post-roll, if it's near the end of the file.
        if (toSec(user.size) - toSec(start) <= MAX_BREAK_SEC + 10) ads.push({ start: toSec(start), end: toSec(user.size) });
        else return null;
        break;
      }
      for (const x of ok) x.ref.off = x.re.off;
      live = live.filter((ref) => !results.some((x) => x.ref === ref && !x.re)); // copies that can't be lined up again
      const end = Math.max(...ok.map((x) => x.re.resume));
      if (end - start > 0.3 * bps) ads.push({ start: toSec(start), end: toSec(end) });
      pos = Math.max(end, lo);
    }

    // Merge touching/overlapping ranges (an ad break where the copies' ads differ partway).
    ads.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const a of ads) {
      const last = merged[merged.length - 1];
      if (last && a.start <= last.end + 0.5) last.end = Math.max(last.end, a.end);
      else merged.push({ ...a });
    }
    const adTime = merged.reduce((t, a) => t + a.end - a.start, 0);
    if (adTime > fileDuration * 0.5) return null;
    return merged;
  }

  return { detect, detectMapped, detectCompare, prefetchMap, forgetMap };
})();
