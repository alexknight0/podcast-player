// Android app (Capacitor wrapper in native/) support. Does nothing in a normal browser.
// The app's WebView ignores the Media Session API (no notification, no lock-screen controls,
// and Android suspends audio once the app is in the background), so navigator.mediaSession
// is replaced by a stand-in that forwards to the @capgo/capacitor-media-session plugin. That
// plugin shows the media notification and runs a foreground service while an episode plays.
// app.js keeps using navigator.mediaSession as in the browser.
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

  window.NativeApp = { isNative: true };
})();
