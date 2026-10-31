// Version light next to the list title: green = running the latest deploy, orange
// "Update" = GitHub Pages has a newer copy (Pages lets browsers cache files for 10 min),
// hollow grey = couldn't check (offline?).
import { VERSION } from "./version.js";

const APP_FILES = [
  "./", "index.html", "style.css", "manifest.webmanifest", "version.js",
  "id3.js", "ads.js", "progress.js", "app.js", "sync.js", "update.js",
];
const CHECK_MS = 5 * 60_000;
const btn = document.getElementById("version");
let latest = null;

function formatVersion(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function setState(state) {
  const labels = {
    checking: "Checking for updates…",
    ok: `Up to date (version ${formatVersion(VERSION)})`,
    stale: `Update available: running ${formatVersion(VERSION)}, latest is ${formatVersion(latest)}. Tap to update.`,
    unknown: `Couldn't check for updates (offline?). Running ${formatVersion(VERSION)}.`,
    updating: "Updating…",
  };
  btn.dataset.state = state;
  btn.title = labels[state];
  btn.setAttribute("aria-label", labels[state]);
  btn.querySelector("span").textContent = state === "stale" ? "Update" : "";
}

async function check() {
  try {
    const res = await fetch(`version.js?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    latest = (await res.text()).match(/VERSION = "([^"]+)"/)?.[1];
    if (!latest) throw new Error("no version");
    // ISO timestamps compare as strings; only a newer live copy counts as an update.
    setState(latest > VERSION ? "stale" : "ok");
  } catch {
    setState("unknown");
  }
}

// The result of a tap shows in the list's status line for a few seconds, unless that line
// is already in use (e.g. "Loading episodes…" or a load error).
const status = document.getElementById("list-status");
let shown = null;
let clearTimer = null;

function report(text) {
  if (status.textContent && status.textContent !== shown) return;
  clearTimeout(clearTimer);
  setStatus(status, text, btn.dataset.state === "checking");
  shown = text;
  clearTimer = setTimeout(() => {
    if (status.textContent === shown) setStatus(status, "");
    shown = null;
  }, 4000);
}

btn.addEventListener("click", async () => {
  const state = btn.dataset.state;
  if (state === "checking" || state === "updating") return;
  if (state !== "stale") {
    // Green or grey: check again now and report the result.
    setState("checking");
    report(btn.title);
    await check();
    report(btn.title);
    return;
  }
  setState("updating");
  Progress.flush(); // push the saved position to sync before the page goes away
  // Refresh every file in the HTTP cache first; a plain reload could still use the stale copies.
  await Promise.all(APP_FILES.map((f) => fetch(f, { cache: "reload" }).catch(() => {})));
  location.reload();
});

setState("checking");
check();
setInterval(check, CHECK_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
window.addEventListener("online", check);
