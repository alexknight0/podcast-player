"use strict";

// Shows. H&A comes from the iTunes API (Omny-hosted: ID3 chapters). The Megaphone
// shows come from their RSS feeds (CORS *, full back catalogue; iTunes caps at 200)
// and have no chapters. Ads on all three are found with maps precomputed by
// tools/admap.py (`admaps`; see ads.js); for H&A, ads.js can also detect them from
// the MP3 frames (`ads`) on recent episodes that don't have a map yet.
const SHOWS = {
  handa: {
    name: "Hamish & Andy",
    lookup: "https://itunes.apple.com/lookup?id=213334232&media=podcast&entity=podcastEpisode&limit=200",
    chapters: true,
    ads: true,
    admaps: true,
  },
  lemonade: { name: "Lemonade Stand", rss: "https://feeds.megaphone.fm/VMP5629614579", admaps: true },
  triforce: { name: "Triforce!", rss: "https://feeds.megaphone.fm/NSR9016694791", admaps: true },
};
const DEFAULT_SHOW = "handa";
const SKIP_SECONDS = 10;
const SAVE_EVERY_SECONDS = 5;

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const seek = $("seek");

let show = SHOWS[localStorage.getItem("show")] ? localStorage.getItem("show") : DEFAULT_SHOW; // show in the list view
let episodes = [];      // episodes of `show`: [{guid, show, title, date, durationSec, url, art}]
let current = null;     // episode currently loaded into <audio>
let chapters = [];      // chapters for `current`, in episode time
let ads = [];           // ad breaks in the stream for `current`, in file time [{start, end}]
let dragging = false;   // true while the user is dragging the seek bar
let lastSaved = 0;
let chapterAbort = null;
let resumeAt = null;    // episode-time position to apply once the audio (and ad map) is ready
let adsSettled = false; // ad detection finished (or isn't possible) for `current`
let adsDetected = false; // detection actually ran on `current` (ads, if any, are known and skipped)
let streamInfo = null;  // { url, tagSize } from the ID3 read, used for ad detection

// ---------- time model ----------
// The stream served to browsers has ads stitched in, but chapter times, the
// iTunes duration and saved progress are all in *episode time* (ads removed).
// audio.currentTime / the seek bar are in *file time*.

function toEpisodeTime(f) {
  let t = f;
  for (const ad of ads) {
    if (f <= ad.start) break;
    t -= Math.min(f, ad.end) - ad.start;
  }
  return Math.max(0, t);
}

function toFileTime(e) {
  let f = e;
  for (const ad of ads) {
    // An ad inserted at or before this moment of the episode plays first.
    if (ad.start <= f) f += ad.end - ad.start;
    else break;
  }
  return f;
}

const adAt = (f) => ads.find((ad) => f >= ad.start && f < ad.end);

function fileDuration() {
  return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
}

// Episode length without ads, matching the episode list.
function episodeDuration() {
  const f = fileDuration();
  if (!f) return current?.durationSec || 0;
  return toEpisodeTime(f);
}

// ---------- helpers ----------

function fmtTime(sec, round = false) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = round ? Math.round(sec) : Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
// Durations are rounded (2706.99 s -> 45:07), elapsed times floored.
const fmtDuration = (sec) => fmtTime(sec, true);

const fmtDate = (d) =>
  d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// Measured episode lengths, so the list shows exactly what the player shows.
const durations = JSON.parse(localStorage.getItem("durations") || "{}");
const listDuration = (ep) => durations[ep.guid] || ep.durationSec;
function rememberDuration(guid, sec) {
  if (!sec || Math.abs((durations[guid] || 0) - sec) < 0.5) return;
  durations[guid] = Math.round(sec * 10) / 10;
  localStorage.setItem("durations", JSON.stringify(durations));
}

// Progress lives in progress.js (local storage, synced by sync.js when signed in).
// Positions are stored in episode time so they survive different ad loads.
const getPos = (guid) => Progress.get(guid).pos;
const isDone = (guid) => Progress.get(guid).done;
const FINISHED_WITHIN_SECONDS = 60; // counts as played once this close to the end

function setDone(guid, done) {
  Progress.setDone(guid, done);
  if (current && current.guid === guid) updateDoneButton();
}

function savePos() {
  if (!current || !isFinite(audio.currentTime) || resumeAt !== null) return;
  const pos = toEpisodeTime(audio.currentTime);
  Progress.setPos(current.guid, pos);
  lastSaved = audio.currentTime;
  const d = episodeDuration();
  if (d && d - pos <= FINISHED_WITHIN_SECONDS && !isDone(current.guid)) {
    setDone(current.guid, true);
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Status line text; `loading` adds a spinner in front of it.
function setStatus(node, text, loading = false) {
  node.textContent = text;
  node.classList.toggle("loading", loading && Boolean(text));
}

// ---------- episode list ----------

// Descriptions aren't shown, so they aren't kept (Triforce's alone would be ~1 MB of localStorage).
function fromItunes(r, key) {
  return {
    guid: r.episodeGuid || String(r.trackId),
    show: key,
    title: r.trackName,
    date: new Date(r.releaseDate),
    durationSec: (r.trackTimeMillis || 0) / 1000,
    url: r.episodeUrl,
    art: r.artworkUrl600 || r.artworkUrl160,
  };
}

// itunes:duration is either plain seconds or [HH:]MM:SS.
const parseDuration = (s) => (s || "").split(":").reduce((acc, part) => acc * 60 + (Number(part) || 0), 0);

// Megaphone enclosures go through ~5 measurement-tracker redirects (podtrac,
// podscribe, ...) before reaching Megaphone, which cost ~4s per episode open.
// Go straight to Megaphone (it still counts the download and serves the ads).
const directUrl = (url) => {
  const m = url.match(/(?:^|\/)(traffic\.megaphone\.fm\/.+)$/);
  return m ? `https://${m[1]}` : url;
};

function parseRss(text, key) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("bad RSS feed");
  const tag = (node, name) => node.getElementsByTagName(name)[0];
  const channelArt = tag(xml, "itunes:image")?.getAttribute("href") || "";
  return [...xml.getElementsByTagName("item")].map((item) => {
    const url = tag(item, "enclosure")?.getAttribute("url");
    return url && {
      guid: tag(item, "guid")?.textContent.trim() || url,
      show: key,
      title: tag(item, "title")?.textContent.trim() || "Untitled",
      date: new Date(tag(item, "pubDate")?.textContent),
      durationSec: parseDuration(tag(item, "itunes:duration")?.textContent),
      url: directUrl(url),
      art: tag(item, "itunes:image")?.getAttribute("href") || channelArt,
    };
  }).filter(Boolean);
}

async function fetchEpisodes(key) {
  const cfg = SHOWS[key];
  const resp = await fetch(cfg.lookup || cfg.rss);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const list = cfg.lookup
    ? (await resp.json()).results
      .filter((r) => r.wrapperType === "podcastEpisode" && r.episodeUrl)
      .map((r) => fromItunes(r, key))
    : parseRss(await resp.text(), key);
  return list.sort((a, b) => b.date - a.date);
}

// Per-show episode lists, kept in localStorage `episodes:<show>` so the list shows instantly.
const lists = {};
function cachedEpisodes(key) {
  if (!lists[key]) {
    // H&A's list used to live under plain `episodes`.
    const raw = localStorage.getItem(`episodes:${key}`) || (key === "handa" && localStorage.getItem("episodes"));
    lists[key] = raw ? JSON.parse(raw).map((e) => ({ ...e, show: key, url: directUrl(e.url), date: new Date(e.date) })) : [];
  }
  return lists[key];
}

// Refresh the current show's list from the network (one request per show at a time).
const inflight = {};
function loadEpisodes() {
  const key = show;
  inflight[key] ||= refreshEpisodes(key).finally(() => { delete inflight[key]; });
  return inflight[key];
}

async function refreshEpisodes(key) {
  const status = $("list-status");
  const isCurrent = () => key === show;
  setStatus(status, episodes.length ? "" : "Loading episodes…", true);
  $("refresh").classList.add("spinning");
  try {
    const list = await fetchEpisodes(key);
    lists[key] = list;
    try {
      localStorage.setItem(`episodes:${key}`, JSON.stringify(list));
      if (key === "handa") localStorage.removeItem("episodes");
    } catch { /* storage full: keep the list in memory only */ }
    if (!isCurrent()) return;
    episodes = list;
    setStatus(status, "");
    renderList();
  } catch (err) {
    if (!isCurrent()) return;
    setStatus(status, episodes.length
      ? `Couldn't refresh (${err.message}). Showing saved list.`
      : `Couldn't load episodes (${err.message}).`);
  } finally {
    if (isCurrent()) $("refresh").classList.remove("spinning");
  }
}

// Switch the list view to another show.
function setShow(key) {
  show = key;
  localStorage.setItem("show", key);
  $("list-title").textContent = SHOWS[key].name;
  for (const btn of $("show-tabs").children) btn.setAttribute("aria-pressed", String(btn.dataset.show === key));
  episodes = cachedEpisodes(key);
  setStatus($("list-status"), episodes.length ? "" : "Loading episodes…", true);
  $("refresh").classList.toggle("spinning", Boolean(inflight[key]));
  renderList();
  window.scrollTo(0, 0);
  loadEpisodes();
}

$("show-tabs").replaceChildren(...Object.entries(SHOWS).map(([key, cfg]) => {
  const btn = el("button", { type: "button", textContent: cfg.name });
  btn.dataset.show = key;
  btn.addEventListener("click", () => { if (key !== show) setShow(key); });
  return btn;
}));

function renderList() {
  const ul = $("episodes");
  ul.replaceChildren(
    ...episodes.map((ep) => {
      const pos = getPos(ep.guid);
      const done = isDone(ep.guid);
      const len = listDuration(ep);
      const pct = len ? Math.min(100, (pos / len) * 100) : 0;
      let progress = "";
      if (done) progress = " · ✓ Played";
      else if (pos > 0) progress = ` · ${fmtDuration(Math.max(0, len - pos))} left`;
      const meta = `${fmtDate(ep.date)} · ${fmtDuration(len)}${progress}`;
      const btn = el("button", { type: "button" },
        el("span", { className: "ep-name", textContent: ep.title }),
        el("span", { className: "ep-meta", textContent: meta }),
      );
      if (pct > 0 && !done) {
        const bar = el("span", { className: "ep-progress" }, el("span"));
        bar.firstChild.style.width = `${pct}%`;
        btn.append(bar);
      }
      btn.addEventListener("click", () => { location.hash = `ep=${encodeURIComponent(ep.guid)}&show=${ep.show}`; });
      return el("li", { className: done ? "done" : "" }, btn);
    }),
  );
}

// ---------- player ----------

function openEpisode(ep) {
  $("ep-title").textContent = ep.title;
  document.title = ep.title;
  if (current && current.guid === ep.guid) {
    // Already loaded; keep playing. If it was finished and left at the end, rewind.
    if (audio.paused && isDone(ep.guid) && episodeDuration() - toEpisodeTime(audio.currentTime) <= FINISHED_WITHIN_SECONDS) seekTo(0);
    return;
  }

  if (current) savePos();
  current = ep;
  chapters = [];
  ads = [];
  adsSettled = false;
  adsDetected = false;
  streamInfo = null;
  loadProgress = 0;
  setLoadProgress(0);
  renderChapters();

  audio.src = ep.url;
  let resume = getPos(ep.guid);
  // A finished episode reopened from near its end starts again from the beginning.
  if (isDone(ep.guid) && listDuration(ep) - resume <= FINISHED_WITHIN_SECONDS) resume = 0;
  // Start ~2s before where we left off, for context. Applied once the audio and ad map are ready.
  resumeAt = resume > 0 ? Math.max(0, resume - 2) : null;
  playPending = false;
  seek.max = 0;
  seek.value = 0;
  updateTimes();
  updateDoneButton();
  updateLoading();
  setBusy(false);
  setupMediaSession();
  $("chapters-section").hidden = !SHOWS[ep.show].chapters;
  loadChapters(ep);
  if (autoplayOnOpen) {
    autoplayOnOpen = false;
    play(); // queued until loading finishes
  }
}

async function loadChapters(ep) {
  if (chapterAbort) chapterAbort.abort();
  chapterAbort = new AbortController();
  const signal = chapterAbort.signal;
  // Shows without chapters only need the ID3 tag size (for ad maps) before detectAds.
  if (!SHOWS[ep.show].chapters) {
    if (SHOWS[ep.show].admaps) {
      Ads.prefetchMap(ep.guid); // in parallel with the redirects below
      try {
        const info = await ID3.readTagSize(ep.url, signal);
        if (current !== ep) return;
        streamInfo = { url: info.url, tagSize: info.tagSize };
        setLoadProgress(LOAD_STAGES.chapters);
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }
    return detectAds(ep, signal);
  }
  setStatus($("chapter-status"), "Loading chapters…", true);
  if (SHOWS[ep.show].admaps) Ads.prefetchMap(ep.guid);
  try {
    const info = await ID3.readChapters(ep.url, signal);
    if (current !== ep) return;
    streamInfo = { url: info.url, tagSize: info.tagSize };
    // The first chapter on these episodes is the intro jingle, titled with the episode name.
    chapters = info.chapters.map((c, i) => ({
      ...c,
      title: i === 0 && (c.title === ep.title || !c.title) ? "Intro" : c.title || `Chapter ${i + 1}`,
    }));
    setStatus($("chapter-status"), chapters.length ? "" : "No chapters in this episode.");
    setLoadProgress(LOAD_STAGES.chapters);
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus($("chapter-status"), `Couldn't load chapters (${err.message}).`);
  }
  renderChapters();
  detectAds(ep, signal);
}

// Locate stitched-in ads so chapter markers and times line up (see ads.js).
async function detectAds(ep, signal) {
  if (!fileDuration()) await new Promise((r) => audio.addEventListener("loadedmetadata", r, { once: true }));
  if (current !== ep || signal.aborted) return;
  const cacheKey = `ads:${ep.guid}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached && Math.abs(cached.fileDuration - fileDuration()) < 0.5) {
      ads = cached.ads;
      adsDetected = true;
    } else if (streamInfo && (SHOWS[ep.show].ads || SHOWS[ep.show].admaps)) {
      const onProgress = (done, total) => {
        if (current === ep) setLoadProgress(LOAD_STAGES.metadata + (1 - LOAD_STAGES.metadata) * (done / total));
      };
      let found = SHOWS[ep.show].admaps
        ? await Ads.detectMapped(ep.guid, streamInfo.url, streamInfo.tagSize, fileDuration(), signal, onProgress)
        : null;
      // No map (yet), or it doesn't fit this copy: H&A can still detect from the MP3 frames.
      if (found === null && SHOWS[ep.show].ads && current === ep) {
        found = await Ads.detect(streamInfo.url, streamInfo.tagSize, fileDuration(), signal, onProgress);
      }
      if (current !== ep) return;
      ads = found || [];
      adsDetected = Boolean(found);
      if (found) localStorage.setItem(cacheKey, JSON.stringify({ fileDuration: fileDuration(), ads }));
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    ads = []; // play on with unadjusted times
  }
  adsSettled = true;
  updateAdBadge();
  setLoadProgress(1);
  rememberDuration(ep.guid, episodeDuration());
  applyResume();
  renderTrack();
  syncUi();
  updateLoading();
  // If playback started before detection finished and is inside an ad, skip it now.
  if (resumeAt === null && adAt(audio.currentTime)) seekTo(audio.currentTime);
  // Play was pressed while loading: start now, from the resume point with ads known.
  if (playPending) {
    playPending = false;
    play();
  }
}

// Loading progress (0..1) shown in the placeholder ring. Reading chapters and the
// audio metadata are quick and count for a little; ad detection (one tiny Range
// request per probe, reported by Ads.detect) is the rest.
const LOAD_STAGES = { chapters: 0.08, metadata: 0.15 };
let loadProgress = 0;
function setLoadProgress(p) {
  loadProgress = Math.max(loadProgress, Math.min(1, p));
  const pct = Math.round(loadProgress * 100);
  $("seek-wrap").style.setProperty("--p", pct);
  $("load-pct").textContent = `Loading… ${pct}%`;
  document.querySelector(".seek-loading").setAttribute("aria-valuenow", String(pct));
}

// The seek bar shows a loading placeholder until the audio length and ad map are known.
function updateLoading(failed = false) {
  if (current && fileDuration()) setLoadProgress(LOAD_STAGES.metadata);
  const loading = Boolean(current) && !failed && !(fileDuration() && adsSettled);
  if (failed && playPending) { playPending = false; setBusy(false); }
  $("seek-wrap").classList.toggle("loading", loading);
  $("seek-wrap").setAttribute("aria-busy", String(loading));
}

// "AD" badge between the times: whether ad detection has run on this episode.
// The tooltip shows on hover, or on tap (focus) on phones.
function updateAdBadge() {
  const badge = $("ad-badge");
  const n = ads.length;
  const text = adsDetected
    ? n ? `Ad detection has run: ${n} ad break${n === 1 ? "" : "s"} skipped.` : "Ad detection has run: no ads found."
    : "Ad detection hasn't run on this episode. Contact the website owner if you want it run.";
  badge.dataset.state = adsDetected ? "on" : "off";
  badge.setAttribute("aria-label", text);
  $("ad-tip").textContent = text;
}

// Spinner on the play button while audio is buffering.
function setBusy(busy) {
  $("play").classList.toggle("busy", busy);
  $("play").setAttribute("aria-busy", String(busy));
}

// Seek to the saved position once metadata and the ad map are ready.
// `force` applies it immediately (e.g. the user pressed play first).
function applyResume(force = false) {
  if (resumeAt === null || !fileDuration() || (!adsSettled && !force)) return;
  audio.currentTime = toFileTime(resumeAt);
  resumeAt = null;
  syncUi();
}

function chapterIndexAt(t) {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) if (chapters[i].start <= t + 0.25) idx = i;
  return idx;
}

function renderChapters() {
  const ol = $("chapters");
  ol.replaceChildren(
    ...chapters.map((c, i) => {
      const btn = el("button", { type: "button" },
        el("span", { className: "ch-time", textContent: fmtTime(c.start) }),
        el("span", { className: "ch-title", textContent: c.title }),
      );
      btn.addEventListener("click", () => {
        resumeAt = null;
        seekTo(toFileTime(c.start));
        audio.play();
      });
      const li = el("li", {}, btn);
      li.dataset.i = i;
      return li;
    }),
  );
  renderTrack();
  highlightChapter(true);
}

// ---------- seek bar track: one segment per chapter, ads shown striped ----------

function renderTrack() {
  const track = $("seek-track");
  const total = fileDuration();
  if (!total) return track.replaceChildren();

  // Chapter boundaries in file time, then cut the ad breaks out as their own segments.
  const starts = chapters.length ? chapters.map((c) => toFileTime(c.start)) : [0];
  starts[0] = 0;
  const pieces = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : total;
    let from = start;
    for (const ad of ads) {
      if (ad.end <= from || ad.start >= end) continue;
      if (ad.start > from) pieces.push({ start: from, end: ad.start, chapter: i });
      from = Math.min(end, ad.end);
    }
    if (from < end) pieces.push({ start: from, end, chapter: i });
  });
  for (const ad of ads) pieces.push({ start: ad.start, end: Math.min(ad.end, total), ad: true });
  pieces.sort((a, b) => a.start - b.start);

  track.replaceChildren(
    ...pieces.filter((p) => p.end - p.start > 2).map((p) => {
      const seg = el("div", { className: p.ad ? "seg ad" : "seg" }, el("div", { className: "fill" }));
      seg.style.left = `${(p.start / total) * 100}%`;
      seg.style.width = `calc(${((p.end - p.start) / total) * 100}% - 4px)`;
      seg.dataset.start = p.start;
      seg.dataset.end = p.end;
      if (!p.ad) seg.dataset.chapter = p.chapter;
      return seg;
    }),
  );
  updateTrackFill();
}

function updateTrackFill() {
  const f = dragging ? Number(seek.value) : audio.currentTime;
  const active = String(chapterIndexAt(toEpisodeTime(f)));
  for (const seg of $("seek-track").children) {
    const { start, end } = seg.dataset;
    const pct = Math.max(0, Math.min(1, (f - start) / (end - start))) * 100;
    seg.firstChild.style.width = `${pct}%`;
    seg.classList.toggle("active", seg.dataset.chapter === active && !adAt(f));
  }
}

let activeChapter = -2;
let inAd = false;
function highlightChapter(force = false) {
  const f = dragging ? Number(seek.value) : audio.currentTime;
  const idx = chapterIndexAt(toEpisodeTime(f));
  const ad = Boolean(adAt(f));
  if (idx === activeChapter && ad === inAd && !force) return;
  activeChapter = idx;
  inAd = ad;
  for (const li of $("chapters").children) li.classList.toggle("active", Number(li.dataset.i) === idx);
  $("current-chapter").textContent = ad ? "Ad break" : idx >= 0 ? chapters[idx].title : "";
  updateMediaMetadata();
}

// Refresh times, seek bar and chapter highlight from the current position.
function syncUi() {
  if (!dragging) seek.value = audio.currentTime;
  seek.max = Math.floor(fileDuration()) || 0;
  updateTimes();
  updateTrackFill();
  highlightChapter();
  updatePositionState();
}

function seekTo(f) {
  f = Math.max(0, Math.min(fileDuration() || Infinity, f));
  // Ads are skipped: landing inside one jumps to where it ends.
  const ad = adAt(f);
  if (ad) f = Math.min(ad.end, fileDuration() || ad.end);
  audio.currentTime = f;
  seek.value = f;
  syncUi();
  savePos();
}

// Skip by episode time, so ads count as zero length (going back from just
// after an ad lands before it rather than inside it).
const skipBy = (sec) => seekTo(toFileTime(Math.max(0, toEpisodeTime(audio.currentTime) + sec)));

function updateTimes() {
  const f = dragging ? Number(seek.value) : resumeAt !== null ? toFileTime(resumeAt) : audio.currentTime;
  $("time-cur").textContent = fmtTime(resumeAt !== null && !dragging ? resumeAt : toEpisodeTime(f));
  $("time-dur").textContent = fmtDuration(episodeDuration());
}

function updateDoneButton() {
  if (!current) return;
  const done = isDone(current.guid);
  $("mark-done").textContent = done ? "✓ Played — mark as unplayed" : "Mark as played";
  $("mark-done").setAttribute("aria-pressed", String(done));
}

function updatePlayButton() {
  const playing = !audio.paused;
  $("play").textContent = playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
}

// ---------- lock screen / notification controls ----------

function updateMediaMetadata() {
  if (!("mediaSession" in navigator) || !current) return;
  const ch = chapters[activeChapter];
  const showName = SHOWS[current.show].name;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: inAd ? "Ad break" : ch ? ch.title : current.title,
    artist: ch || inAd ? current.title : showName,
    album: showName,
    artwork: current.art ? [{ src: current.art, sizes: "600x600", type: "image/jpeg" }] : [],
  });
}

// The lock screen works in file time, since that's what it scrubs through.
function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = fileDuration();
  if (!d) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, d),
    });
  } catch { /* ignore invalid states during loading */ }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  updateMediaMetadata();
  const handlers = {
    play: () => play(),
    pause: () => (playPending ? togglePlay() : audio.pause()),
    seekbackward: (e) => skipBy(-(e.seekOffset || SKIP_SECONDS)),
    seekforward: (e) => skipBy(e.seekOffset || SKIP_SECONDS),
    seekto: (e) => seekTo(e.seekTime),
    // No previoustrack/nexttrack (they used to jump between chapters): Android's
    // lock screen has only 3 slots and Chrome fills them with prev/next track
    // whenever those are registered, which hid the −10/+10 buttons.
    previoustrack: null,
    nexttrack: null,
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

// ---------- events ----------

// Pressing play while the episode is still loading (length / ad map unknown) queues
// it: the button spins and playback starts when loading finishes (end of detectAds),
// so it begins at the resume point with ads already skippable. Press again to cancel.
let playPending = false;
const stillLoading = () => Boolean(current) && !(fileDuration() && adsSettled);

function play() {
  if (stillLoading()) {
    playPending = true;
    setBusy(true);
    return Promise.resolve();
  }
  applyResume(true);
  if (audio.readyState < 3) setBusy(true);
  return audio.play().catch(() => setBusy(false));
}

function togglePlay() {
  if (playPending) {
    playPending = false;
    setBusy(false);
  } else if (audio.paused) play();
  else audio.pause();
}

$("play").addEventListener("click", togglePlay);
$("back10").addEventListener("click", () => { applyResume(true); skipBy(-SKIP_SECONDS); });
$("fwd10").addEventListener("click", () => { applyResume(true); skipBy(SKIP_SECONDS); });
$("back").addEventListener("click", () => { location.hash = ""; });
$("refresh").addEventListener("click", loadEpisodes);
$("mark-done").addEventListener("click", () => setDone(current.guid, !isDone(current.guid)));

// ---------- autoplay next (off by default, remembered per device) ----------
// When an episode ends, open and play the next one in release order (the next
// newer episode of the same show). Stops after the newest episode.
let autoplayNext = localStorage.getItem("autoplayNext") === "1";
let autoplayOnOpen = false; // set just before routing to the next episode

function updateAutoplayButton() {
  $("autoplay").textContent = `Autoplay next: ${autoplayNext ? "On" : "Off"}`;
  $("autoplay").setAttribute("aria-pressed", String(autoplayNext));
}
updateAutoplayButton();
$("autoplay").addEventListener("click", () => {
  autoplayNext = !autoplayNext;
  localStorage.setItem("autoplayNext", autoplayNext ? "1" : "0");
  updateAutoplayButton();
});

function playNextEpisode() {
  const i = episodes.findIndex((e) => e.guid === current?.guid);
  const next = i > 0 ? episodes[i - 1] : null; // the list is newest first
  if (!next) return;
  autoplayOnOpen = true;
  location.hash = `ep=${encodeURIComponent(next.guid)}&show=${next.show}`;
}

// Seek bar: preview while dragging, seek when released.
seek.addEventListener("input", () => {
  dragging = true;
  resumeAt = null;
  updateTimes();
  updateTrackFill();
  highlightChapter();
});
seek.addEventListener("change", () => {
  dragging = false;
  seekTo(Number(seek.value));
});

audio.addEventListener("loadedmetadata", () => {
  renderTrack();
  applyResume();
  syncUi();
  updateLoading();
});
audio.addEventListener("timeupdate", () => {
  // Auto-skip ads (only known on episodes whose ads could be detected; see ads.js).
  if (!dragging && resumeAt === null && adAt(audio.currentTime)) return seekTo(audio.currentTime);
  if (!dragging && resumeAt === null) syncUi();
  if (Math.abs(audio.currentTime - lastSaved) >= SAVE_EVERY_SECONDS) savePos();
});
audio.addEventListener("play", () => { updatePlayButton(); updatePositionState(); });
audio.addEventListener("pause", () => { setBusy(false); updatePlayButton(); savePos(); });
audio.addEventListener("waiting", () => { if (!audio.paused) setBusy(true); });
audio.addEventListener("playing", () => setBusy(false));
audio.addEventListener("ended", () => {
  setBusy(false);
  updatePlayButton();
  savePos();
  setDone(current.guid, true);
  if (autoplayNext) playNextEpisode();
});
audio.addEventListener("error", () => {
  setBusy(false);
  updateLoading(true);
  setStatus($("chapter-status"), "Couldn't play this episode. Check your connection and try again.");
});

// Keyboard shortcuts (handy on desktop): space = play/pause, arrows = ±10s.
document.addEventListener("keydown", (e) => {
  if ($("player-view").hidden || e.target.tagName === "INPUT") return;
  if (e.key === " ") { e.preventDefault(); $("play").click(); }
  else if (e.key === "ArrowLeft") $("back10").click();
  else if (e.key === "ArrowRight") $("fwd10").click();
});

window.addEventListener("pagehide", savePos);
document.addEventListener("visibilitychange", () => { if (document.hidden) savePos(); });

// ---------- sync (wired up in sync.js) ----------

// Another device changed something: refresh the list and, if the loaded
// episode is paused, jump to its synced position.
Progress.on("change", () => {
  if (!$("list-view").hidden) renderList();
  if (current) {
    updateDoneButton();
    const pos = getPos(current.guid);
    if (audio.paused && Math.abs(pos - toEpisodeTime(audio.currentTime)) > 5) {
      resumeAt = pos;
      applyResume();
      updateTimes();
    }
  }
});

// ---------- routing (#ep=<guid>&show=<key> shows the player; empty hash shows the list) ----------
// Old links without `show` are H&A episodes.

async function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  const guid = params.get("ep");
  if (guid) {
    const key = SHOWS[params.get("show")] ? params.get("show") : DEFAULT_SHOW;
    if (key !== show) setShow(key); // so "back" returns to this show's list
    if (!episodes.length) await loadEpisodes();
    const ep = episodes.find((e) => e.guid === guid);
    if (ep) {
      $("list-view").hidden = true;
      $("player-view").hidden = false;
      window.scrollTo(0, 0);
      openEpisode(ep);
      return;
    }
  }
  $("player-view").hidden = true;
  $("list-view").hidden = false;
  document.title = SHOWS[show].name;
  renderList(); // refresh "listened" progress
}

// ---------- password gate ----------
// Cosmetic only: keeps casual visitors from seeing the content. Anyone can read
// this source (or the public podcast feed) directly.
const PASSWORD = "alex";
const UNLOCK_KEY = "unlocked";

function startApp() {
  document.body.classList.remove("locked");
  window.addEventListener("hashchange", route);
  setShow(show);
  route();
}

if (localStorage.getItem(UNLOCK_KEY) === "1") {
  startApp();
} else {
  $("gate-pw").focus();
  $("gate").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("gate-pw").value === PASSWORD) {
      localStorage.setItem(UNLOCK_KEY, "1"); // remember on this device
      startApp();
    } else {
      $("gate-error").textContent = "Wrong password.";
      $("gate-pw").select();
    }
  });
}
