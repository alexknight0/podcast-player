// Version light next to the list title: green = running the latest deploy, orange
// "Update" = GitHub Pages has a newer copy (Pages lets browsers cache files for 10 min),
// hollow grey = couldn't check (offline?). The light itself is shared by Alex's Pages sites
// (github.com/alexknight0/pages-common); this file wires it up.
import { VERSION } from "./version.js";

const btn = document.getElementById("version");

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

// Loaded dynamically so the player still works if jsDelivr is unreachable.
import("https://cdn.jsdelivr.net/gh/alexknight0/pages-common@1.0.0/update.js")
  .then(({ initUpdateLight }) => initUpdateLight({
    version: VERSION,
    buttons: btn,
    report,
    beforeUpdate() {
      Progress.flush(); // push the saved position to sync before the page goes away
    },
  }))
  .catch((e) => {
    console.warn("update light:", e);
    btn.dataset.state = "unknown";
    btn.title = "Couldn't load the update check (offline?).";
  });
