// Minimal ID3v2.3/2.4 chapter (CHAP) reader.
// Fetches only the ID3 tag at the start of the MP3 using an HTTP Range request,
// so chapters are available without downloading the whole episode.
"use strict";

const ID3 = (() => {
  const INITIAL_BYTES = 64 * 1024;   // ID3 tags on these episodes are ~33 KB
  const MAX_TAG_BYTES = 4 * 1024 * 1024;

  // Read up to `n` bytes from a response body, then stop the download.
  // Handles servers that ignore Range and send the full file (status 200).
  async function readUpTo(resp, n) {
    const reader = resp.body.getReader();
    const out = new Uint8Array(n);
    let len = 0;
    while (len < n) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, n - len);
      out.set(value.subarray(0, take), len);
      len += take;
    }
    reader.cancel().catch(() => {});
    return out.subarray(0, len);
  }

  async function fetchBytes(url, n, signal) {
    return (await fetchRange(url, 0, n, signal)).bytes;
  }

  // Fetch n bytes starting at `start`. Also returns the final URL after redirects.
  async function fetchRange(url, start, n, signal) {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${start + n - 1}` }, cache: "no-store", signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    // A server that ignores Range (200) would send the file from byte 0.
    if (resp.status !== 206 && start > 0) throw new Error("server ignored Range request");
    return { bytes: await readUpTo(resp, n), url: resp.url };
  }

  const syncsafe = (b, o) =>
    ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  const uint32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  // Decode an ID3 text frame body (first byte is the encoding).
  function decodeText(bytes) {
    if (!bytes.length) return "";
    const enc = bytes[0];
    const data = bytes.subarray(1);
    let label = "iso-8859-1";
    if (enc === 3) label = "utf-8";
    else if (enc === 2) label = "utf-16be";
    else if (enc === 1) label = data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-16le";
    return new TextDecoder(label).decode(data).replace(/^\uFEFF/, "").replace(/\0+$/g, "").trim();
  }

  // Walk frames in [start, end). Returns [{id, body}].
  function parseFrames(b, start, end, version) {
    const frames = [];
    let p = start;
    while (p + 10 <= end) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding or garbage
      const size = version === 4 ? syncsafe(b, p + 4) : uint32(b, p + 4);
      const bodyStart = p + 10;
      const bodyEnd = Math.min(bodyStart + size, end);
      frames.push({ id, body: b.subarray(bodyStart, bodyEnd) });
      p = bodyEnd;
    }
    return frames;
  }

  function parseChap(body, version) {
    let p = 0;
    while (p < body.length && body[p] !== 0) p++; // element ID (null-terminated)
    p++;
    if (p + 16 > body.length) return null;
    const startMs = uint32(body, p);
    const endMs = uint32(body, p + 4);
    p += 16; // skip start/end time and start/end byte offsets
    let title = "";
    for (const sub of parseFrames(body, p, body.length, version)) {
      if (sub.id === "TIT2") title = decodeText(sub.body);
    }
    return { start: startMs / 1000, end: endMs / 1000, title };
  }

  // Returns { chapters: [{start, end, title}] (seconds, sorted), tagSize (bytes),
  // url (final URL after redirects, for follow-up Range requests) }.
  async function readChapters(url, signal) {
    let { bytes: b, url: finalUrl } = await fetchRange(url, 0, INITIAL_BYTES, signal);
    const none = { chapters: [], tagSize: 0, url: finalUrl };
    if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return none; // "ID3"
    const version = b[3];
    const flags = b[5];
    const tagEnd = 10 + syncsafe(b, 6) + (flags & 0x10 ? 10 : 0); // + footer
    if (version !== 3 && version !== 4) return { ...none, tagSize: tagEnd };
    if (tagEnd > b.length) {
      if (tagEnd > MAX_TAG_BYTES) return { ...none, tagSize: tagEnd };
      b = await fetchBytes(finalUrl, tagEnd, signal);
    }

    let start = 10;
    if (flags & 0x40) {
      // Extended header: v2.4 size includes itself (syncsafe); v2.3 excludes itself.
      start += version === 4 ? syncsafe(b, 10) : uint32(b, 10) + 4;
    }

    const chapters = parseFrames(b, start, Math.min(tagEnd, b.length), version)
      .filter((f) => f.id === "CHAP")
      .map((f) => parseChap(f.body, version))
      .filter(Boolean)
      .sort((a, c) => a.start - c.start);
    return { chapters, tagSize: tagEnd, url: finalUrl };
  }

  // Just the tag size and final URL (for files whose chapters we don't need).
  async function readTagSize(url, signal) {
    const { bytes: b, url: finalUrl } = await fetchRange(url, 0, 10, signal);
    const isId3 = b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
    return { chapters: [], tagSize: isId3 ? 10 + syncsafe(b, 6) + (b[5] & 0x10 ? 10 : 0) : 0, url: finalUrl };
  }

  return { readChapters, readTagSize };
})();
