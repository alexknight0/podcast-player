"use strict";

// Finds where a show starts by listening for its theme song, which plays right after the
// pre-roll ad. Only the first couple of minutes are fetched (one Range request), decoded
// with Web Audio, reduced to log band energies per frame and matched against a saved
// reference clip of the song (intro/<show>.json, made by tools/make-intro-ref.js).
// Matching is on the audio itself, so it works on any copy whatever ads were stitched in.
const Intro = (() => {
  const SR = 11025;
  const N = 1024;
  const HOP = 256;
  const BANDS = 24;
  const FETCH_BYTES = 3_000_000; // ID3 tag (~200 KB) + ~2 minutes of 160 kbps audio
  const MIN_SCORE = 0.8;         // normalised correlation needed to call it a match

  // Radix-2 FFT, in place.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
  }

  const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  // FFT bin ranges of BANDS log-spaced bands from 100 Hz to 5 kHz.
  const bandEdges = Array.from({ length: BANDS + 1 }, (_, i) => Math.round(((100 * (5000 / 100) ** (i / BANDS)) * N) / SR));

  // Log band energies per frame, minus each frame's mean (so loudness doesn't matter).
  // Returns a Float32Array of frames * BANDS.
  function features(x) {
    const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
    const out = new Float32Array(frames * BANDS);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < N; i++) { re[i] = x[f * HOP + i] * hann[i]; im[i] = 0; }
      fft(re, im);
      let mean = 0;
      for (let b = 0; b < BANDS; b++) {
        let e = 0;
        for (let k = bandEdges[b]; k < Math.max(bandEdges[b] + 1, bandEdges[b + 1]); k++) e += re[k] * re[k] + im[k] * im[k];
        const v = Math.log(e + 1e-8);
        out[f * BANDS + b] = v;
        mean += v;
      }
      mean /= BANDS;
      for (let b = 0; b < BANDS; b++) out[f * BANDS + b] -= mean;
    }
    return out;
  }

  // Decode MP3 bytes to mono samples at SR.
  async function decode(bytes) {
    const ctx = new OfflineAudioContext(1, 1, SR);
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    const x = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < x.length; i++) x[i] += ch[i] / buf.numberOfChannels;
    }
    return x;
  }

  // Best match of the reference (frames * BANDS, any scale) within feats. Returns {time, score}.
  function bestMatch(feats, ref, refFrames) {
    const dim = refFrames * BANDS;
    const q = Float32Array.from(ref);
    let qm = 0;
    for (const v of q) qm += v;
    qm /= dim;
    let qn = 0;
    for (let i = 0; i < dim; i++) { q[i] -= qm; qn += q[i] * q[i]; }
    qn = Math.sqrt(qn) || 1;
    const frames = feats.length / BANDS;
    // Running sums over the window give its mean and norm without re-reading it.
    const prefix = new Float64Array(frames + 1), prefix2 = new Float64Array(frames + 1);
    for (let f = 0; f < frames; f++) {
      let s = 0, s2 = 0;
      for (let b = 0; b < BANDS; b++) { const v = feats[f * BANDS + b]; s += v; s2 += v * v; }
      prefix[f + 1] = prefix[f] + s;
      prefix2[f + 1] = prefix2[f] + s2;
    }
    let best = { time: null, score: -1 };
    for (let off = 0; off + refFrames <= frames; off++) {
      let dot = 0;
      const base = off * BANDS;
      for (let i = 0; i < dim; i++) dot += feats[base + i] * q[i];
      const sum = prefix[off + refFrames] - prefix[off];
      const sum2 = prefix2[off + refFrames] - prefix2[off];
      const wn = Math.sqrt(Math.max(sum2 - (sum * sum) / dim, 1e-9));
      const score = dot / (wn * qn); // q is zero-mean, so no need to centre the window
      if (score > best.score) best = { time: (off * HOP) / SR, score };
    }
    return best;
  }

  const refCache = new Map();
  function loadRef(name) {
    if (!refCache.has(name)) {
      refCache.set(name, fetch(`intro/${name}.json`).then((r) => {
        if (!r.ok) throw new Error(`no intro reference (HTTP ${r.status})`);
        return r.json();
      }).then((j) => ({ frames: j.frames, data: Float32Array.from(j.data) })));
    }
    return refCache.get(name);
  }

  // Start of the show's theme song in file seconds, or null if it isn't in the first minutes.
  async function find(url, name, signal) {
    const [ref, resp] = await Promise.all([
      loadRef(name),
      fetch(url, { headers: { Range: `bytes=0-${FETCH_BYTES - 1}` }, cache: "no-store", signal }),
    ]);
    if (resp.status !== 206) throw new Error(`range request failed (HTTP ${resp.status})`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const best = bestMatch(features(await decode(bytes)), ref.data, ref.frames);
    return best.score >= MIN_SCORE ? best : null;
  }

  return { find, features, decode, bestMatch, SR, HOP, BANDS, MIN_SCORE };
})();
