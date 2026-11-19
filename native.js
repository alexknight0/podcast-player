// Android app (Capacitor wrapper in native/) support. Does nothing in a normal browser.
// The app's WebView ignores the Media Session API (no notification, no lock-screen controls,
// and Android suspends audio once the app is in the background), so navigator.mediaSession
// is replaced by a stand-in that forwards to the @capgo/capacitor-media-session plugin. That
// plugin shows the media notification and runs a foreground service while an episode plays.
// app.js keeps using navigator.mediaSession as in the browser.
// The app's User-Agent has "PodcastPlayer/1.0 okhttp/4.12.0" appended (appendUserAgent in
// native/capacitor.config.json): with that, Omny serves H&A without ads (it stitches ads only
// for browser User-Agents), so there's nothing to skip. app.js checks the file length.
(() => {
  const C = window.Capacitor;
  if (!C?.isNativePlatform?.()) return;
  const MS = C.Plugins.MediaSession;
  if (!MS) return;
  const log = (err) => console.warn("MediaSession plugin:", err);

  const handlers = {};
  const registered = new Set();
  let metadata = null;
  const shim = {
    get metadata() { return metadata; },
    set metadata(m) {
      metadata = m;
      if (!m) return;
      MS.setMetadata({
        title: m.title, artist: m.artist, album: m.album,
        artwork: [...(m.artwork || [])].map((a) => ({ src: a.src, sizes: a.sizes, type: a.type })),
      }).catch(log);
    },
    set playbackState(state) { MS.setPlaybackState({ playbackState: state }).catch(log); },
    setActionHandler(action, fn) {
      handlers[action] = fn;
      // Only actions with a handler appear on the notification, so null ones are never sent.
      if (!fn || registered.has(action)) return;
      registered.add(action);
      MS.setActionHandler({ action }, (data, err) => {
        if (err) return log(err);
        handlers[action]?.({ action, ...data });
      });
    },
    setPositionState(state) {
      if (!state) return;
      MS.setPositionState(state).catch(log);
    },
  };
  Object.defineProperty(navigator, "mediaSession", { value: shim, configurable: true });
  // WebView doesn't define MediaMetadata either; app.js only needs a plain holder.
  if (!window.MediaMetadata) {
    window.MediaMetadata = class MediaMetadata {
      constructor({ title = "", artist = "", album = "", artwork = [] } = {}) {
        Object.assign(this, { title, artist, album, artwork });
      }
    };
  }

  // The browser tracks playing/paused itself; the plugin has to be told.
  document.addEventListener("DOMContentLoaded", () => {
    const audio = document.getElementById("audio");
    const state = (s) => () => { shim.playbackState = s; };
    audio.addEventListener("playing", state("playing"));
    audio.addEventListener("pause", state("paused"));
    // No "none" on episode change: that stops the foreground service, and Android may not
    // allow restarting it from the background (autoplay next on the lock screen).
  });

  window.NativeApp = { isNative: true, compareCopies, prepareCopies };

  // ---------- other copies of an episode (Megaphone ad detection, see Ads.detectCompare) ----------
  // Megaphone stitches different ads into the copy each User-Agent gets. A web page can't set
  // User-Agent, so the reference copies are read with the built-in CapacitorHttp plugin
  // (native HttpURLConnection). Each copy's final signed URL pins that copy whatever
  // User-Agent fetches it, so the user's copy (the final URL the WebView was redirected to)
  // is read the same way; native reads also expose Content-Range, which CORS hides from fetch.
  const REF_USER_AGENTS = [
    "AppleCoreMedia/1.0.0.22A3354 (iPhone; U; CPU OS 18_0 like Mac OS X; en_au)",
    "Pocket Casts",
    "Overcast/3.0 (+http://overcast.fm/; iOS podcast app)",
    "curl/8.7.1",
  ];
  const REFS_WANTED = 3;   // other copies compared (2 missed a pre-roll whose first ad matched one copy)
  const MAX_IN_FLIGHT = 64; // native requests at once
  const Http = C.Plugins.CapacitorHttp;
  const fromBase64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  const header = (h, name) => Object.entries(h || {}).find(([k]) => k.toLowerCase() === name)?.[1];

  // Each native request ties up a thread; queue beyond MAX_IN_FLIGHT.
  let inFlight = 0;
  const waiting = [];
  async function limited(fn) {
    if (inFlight >= MAX_IN_FLIGHT) await new Promise((r) => waiting.push(r));
    inFlight++;
    try { return await fn(); } finally { inFlight--; waiting.shift()?.(); }
  }

  // A request failing aborts the whole comparison, so retry a couple of times first
  // (seen once on a copy Megaphone was still making).
  async function retried(fn, signal) {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      try {
        return await fn();
      } catch (err) {
        if (err.name === "AbortError" || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }

  async function nativeRange(url, ua, start, len, signal) {
    const r = await retried(async () => {
      const res = await limited(() => Http.request({
        url, method: "GET", responseType: "arraybuffer",
        headers: { "User-Agent": ua, Range: `bytes=${start}-${start + len - 1}` },
      }));
      if (res.status !== 206) throw new Error(`range request failed (HTTP ${res.status})`);
      return res;
    }, signal);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    return { data: fromBase64(r.data || ""), url: r.url, total: Number(String(header(r.headers, "content-range") || "").split("/")[1]) };
  }

  // {size, tagSize, read(start, len)} for the copy `ua` gets from `url`.
  async function nativeCopy(url, ua, signal) {
    const first = await nativeRange(url, ua, 0, 10, signal);
    const h = first.data;
    const tagSize = h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33 ? 10 + ((h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9]) : 0;
    if (!first.total) throw new Error("no file size");
    const final = first.url || url;
    // Copies with the same signed key are the same stitch (seen: two User-Agents given one copy).
    const id = new URL(final).searchParams.get("key") || `${final.split("?")[0]}#${first.total}`;
    return { id, size: first.total, tagSize, read: async (start, len) => (await nativeRange(final, ua, start, len, signal)).data };
  }

  // The user's copy: size and tag from one native request (CORS hides Content-Range from
  // fetch), then reads through the WebView's fetch, which multiplexes them over HTTP/2.
  async function userCopy(url, signal) {
    const c = await nativeCopy(url, navigator.userAgent, signal);
    const read = (start, len) => retried(async () => {
      const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + len - 1}` }, cache: "no-store", signal });
      if (r.status !== 206) throw new Error(`range request failed (HTTP ${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    }, signal);
    return { ...c, read };
  }

  // Started as soon as the episode's final URL is known (loadChapters), so the other copies'
  // redirects, and Megaphone making each copy (its first requests can take 2+ s), overlap
  // with loading the audio. Up to REFS_WANTED distinct copies other than the user's.
  const prepared = new Map(); // guid -> Promise<{user, refs}>
  function prepareCopies(ep, streamInfo, signal) {
    const key = ep.guid;
    if (!prepared.has(key) || prepared.get(key).url !== streamInfo.url) {
      const p = (async () => {
        const all = await Promise.allSettled([
          userCopy(streamInfo.url, signal),
          ...REF_USER_AGENTS.map((ua) => nativeCopy(ep.url, ua, signal)),
        ]);
        if (all[0].status !== "fulfilled") throw all[0].reason;
        const user = all[0].value;
        const refs = [];
        for (const s of all.slice(1)) {
          if (s.status !== "fulfilled" || s.value.id === user.id || refs.some((r) => r.id === s.value.id)) continue;
          if (refs.length < REFS_WANTED) refs.push(s.value);
        }
        return { user, refs };
      })();
      p.url = streamInfo.url;
      p.catch(() => prepared.delete(key));
      prepared.set(key, p);
    }
    return prepared.get(key);
  }

  // Ad ranges in the user's copy (file seconds), [] for none, or null if it can't be done.
  // fileDuration may be null (not loaded yet); the copy's size and bitrate give it then.
  async function compareCopies(ep, streamInfo, fileDuration, signal, onProgress) {
    if (!Http) return null;
    const { user, refs } = await prepareCopies(ep, streamInfo, signal);
    prepared.delete(ep.guid); // the signal it was made with ends with this detection
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (!refs.length) return null;
    const t0 = Date.now();
    const ads = await Ads.detectCompare(user, refs, fileDuration, onProgress);
    console.log(`compareCopies: ${refs.length} copies, ${Date.now() - t0} ms`, JSON.stringify(ads));
    return ads;
  }
})();
