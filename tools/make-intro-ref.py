"""Save the reference clip Intro.find() matches against (intro/<show>.json).

Usage: make-intro-ref.py <mp3> <song start seconds> <show> [clip seconds]
The mp3 is any copy of an episode; the start is where the show's theme song begins in it
(found with the saved ground truth, or by ear). Features come from intro.js itself, run
in headless Chromium, so the reference is made by the same decode and feature code that
later matches it. Needs playwright (see ~/projects/ai-tool-venv) and the repo served on
http://localhost:8765/.
"""
import base64
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

mp3, start, show = sys.argv[1], float(sys.argv[2]), sys.argv[3]
clip = float(sys.argv[4]) if len(sys.argv) > 4 else 7.0
repo = Path(__file__).resolve().parent.parent
data = base64.b64encode(Path(mp3).read_bytes()[:3_000_000]).decode()

with sync_playwright() as p:
    page = p.chromium.launch().new_page()
    page.goto("http://localhost:8765/tools/blank.html")
    page.add_script_tag(path=str(repo / "intro.js"))
    out = page.evaluate(
        """async ([b64, start, clip]) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const f = Intro.features(await Intro.decode(bytes));
          const first = Math.round((start * Intro.SR) / Intro.HOP);
          const frames = Math.round((clip * Intro.SR) / Intro.HOP);
          return { frames, bands: Intro.BANDS, data: Array.from(f.slice(first * Intro.BANDS, (first + frames) * Intro.BANDS), (v) => +v.toFixed(3)) };
        }""",
        [data, start, clip],
    )
(repo / "intro").mkdir(exist_ok=True)
(repo / "intro" / f"{show}.json").write_text(json.dumps(out, separators=(",", ":")))
print(f"intro/{show}.json: {out['frames']} frames")
