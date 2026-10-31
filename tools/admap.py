#!/usr/bin/env python3
"""Build ad maps for the podcasts with stitched-in ads (run by .github/workflows/admaps.yml).

Megaphone (Lemonade Stand, Triforce) and Omny (Hamish & Andy) stitch ads into every
download, and different user agents get different ads (Omny gives curl none at all).
The show audio itself is byte-identical in every copy, so: download an episode
several times with different user agents, and the MP3 frames that appear exactly once
in every copy are the show; everything else is ads.

The map written to admaps/<guid>.json describes the show audio only ("episode time"):
  frames  - number of show frames (1152 samples each)
  segs    - [[start, length], ...] in show frames; boundaries are the places where
            any copy had an ad (or an empty ad slot), i.e. where ads can appear
  stride, hashes - CRC-32 of every `stride`-th show frame (base64, little-endian
            uint32; 0 = unusable frame). The player Range-fetches a few frames of
            its own copy, looks their CRCs up here, and so learns exactly how many
            seconds of ads come before that point (see ads.js).
Standard library only.
"""
import argparse
import base64
import concurrent.futures
import json
import pathlib
import re
import struct
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from collections import Counter

SHOWS = {
    # Megaphone: each of these user agents got a different set of ads in testing (2026-10).
    "lemonade": {"rss": "https://feeds.megaphone.fm/VMP5629614579"},
    "triforce": {"rss": "https://feeds.megaphone.fm/NSR9016694791"},
    # Omny (H&A): every browser-like UA gets the same ads, and curl gets the ad-free
    # file, so one copy of each pins down the show exactly. Ads depend on location, so
    # build these from Australia (not GitHub Actions, whose US runners get other ads).
    "handa": {
        "itunes": "https://itunes.apple.com/lookup?id=213334232&media=podcast&entity=podcastEpisode&limit=200",
        "uas": ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
                "curl/8.7.1"],
        "min_copies": 2,
    },
}
USER_AGENTS = [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    "curl/8.7.1",
    "ExoPlayerLib/2.18.1",
    "Podcasts/1.1.0 CFNetwork/1474 Darwin/23.0.0",
    "PocketCasts/1.0 (Pocket Casts Feed Parser; +http://pocketcasts.com/)",
]
MIN_COPIES = 4
STRIDE = 16
BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]  # MPEG-1 Layer III, kbps
SAMPLE_RATES = [44100, 48000, 32000]
ITUNES_NS = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "admaps"


def log(msg):
    print(msg, flush=True)


class FrameReader:
    """Incrementally splits an MP3 byte stream into frames, recording each frame's CRC-32."""

    def __init__(self):
        self.buf = bytearray()
        self.skip = None  # bytes of ID3 tag still to skip; None until the header is seen
        self.crcs = []
        self.formats = Counter()  # (kbps, sample rate) -> frames

    def feed(self, chunk):
        self.buf += chunk
        if self.skip is None:
            if len(self.buf) < 10:
                return
            b = self.buf
            self.skip = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) if b[:3] == b"ID3" else 0
        if self.skip:
            n = min(self.skip, len(self.buf))
            del self.buf[:n]
            self.skip -= n
            if self.skip:
                return
        b = self.buf
        p = 0
        while p + 4 <= len(b):
            h1, h2 = b[p + 1], b[p + 2]
            bi, si = h2 >> 4, (h2 >> 2) & 3
            if b[p] != 0xFF or (h1 & 0xFE) != 0xFA or not 0 < bi < 15 or si == 3:
                p += 1  # not an MPEG-1 Layer III frame header: resync
                continue
            size = 144 * BITRATES[bi] * 1000 // SAMPLE_RATES[si] + ((h2 >> 1) & 1)
            if p + size > len(b):
                break
            self.crcs.append(zlib.crc32(b[p:p + size]))
            self.formats[(BITRATES[bi], SAMPLE_RATES[si])] += 1
            p += size
        del b[:p]


def download_hashes(url, ua, label):
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    reader = FrameReader()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                while chunk := resp.read(1 << 20):
                    reader.feed(chunk)
            break
        except Exception as err:  # retry from scratch on network errors
            log(f"    {label}: {err} (attempt {attempt + 1}/3)")
            reader = FrameReader()
            time.sleep(5)
    else:
        return None
    return reader


def read_file_hashes(path):
    reader = FrameReader()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            reader.feed(chunk)
    return reader


def build_map(readers):
    """Separate show frames from ads. Returns the map dict (without guid/title) or raises."""
    copies = [r.crcs for r in readers]
    if len({len(c) for c in copies}) < 2:
        raise ValueError("every copy has the same length, so the ads can't be told apart")
    formats = Counter()
    for r in readers:
        formats.update(r.formats)
    (kbps, rate), n = formats.most_common(1)[0]
    if n != sum(formats.values()):
        log(f"    warning: mixed MP3 formats {dict(formats)}; times may be slightly off")

    counts = [Counter(c) for c in copies]
    show = {h for h, k in counts[0].items() if k == 1 and all(c.get(h) == 1 for c in counts[1:])}
    pos = [{h: i for i, h in enumerate(c) if h in show} for c in copies]
    ref = copies[0]

    # Runs of show frames in the first copy. A gap between two show frames is part of
    # the show if it has the same length in every copy (e.g. the frames re-encoded at
    # an empty ad slot, or repeated silence); otherwise ads were inserted there.
    runs = []  # [first, last] indices into ref
    cuts = []  # ref indices where a same-length gap (likely an empty ad slot) was bridged
    for i, h in enumerate(ref):
        if h not in show:
            continue
        if runs:
            last = runs[-1][1]
            gap = i - last
            if all(abs((p[h] - p[ref[last]]) - gap) <= 1 for p in pos[1:]):
                if gap > 1:
                    cuts.append(last + 1)
                runs[-1][1] = i
                continue
        runs.append([i, i])
    if not runs:
        raise ValueError("no show audio found")

    # Show frames in order (ref indices), and segment boundaries in show-frame units.
    seg_starts = []
    ep = []  # ref index for each show frame
    cut_set = set(cuts)
    for a, b in runs:
        seg_starts.append(len(ep))
        for i in range(a, b + 1):
            if i in cut_set:
                seg_starts.append(len(ep))
            ep.append(i)
    seg_starts = sorted(set(seg_starts))
    segs = [[s, (seg_starts[k + 1] if k + 1 < len(seg_starts) else len(ep)) - s] for k, s in enumerate(seg_starts)]

    hashes = [ref[i] if ref[i] in show else 0 for i in ep[::STRIDE]]
    spf = 1152
    shortest = min(len(c) for c in copies)
    if len(ep) < 0.75 * shortest:
        raise ValueError(f"only {len(ep)} of {shortest} frames look like show audio")
    return {
        "v": 1,
        "kbps": kbps,
        "rate": rate,
        "spf": spf,
        "frames": len(ep),
        "segs": segs,
        "stride": STRIDE,
        "hashes": base64.b64encode(struct.pack(f"<{len(hashes)}I", *hashes)).decode(),
        "copies": len(copies),
        "ads": [round((len(c) - len(ep)) * spf / rate, 1) for c in copies],  # seconds of ads per copy, for reference
    }


def direct_url(url):
    """Skip the measurement-tracker redirects in front of Megaphone files (as the player does)."""
    m = re.search(r"(?:^|/)(traffic\.megaphone\.fm/.+)$", url)
    return f"https://{m.group(1)}" if m else url


def feed_items(show):
    cfg = SHOWS[show]
    req = urllib.request.Request(cfg.get("rss") or cfg["itunes"], headers={"User-Agent": USER_AGENTS[1]})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    if "itunes" in cfg:
        results = [x for x in json.loads(body)["results"] if x.get("wrapperType") == "podcastEpisode" and x.get("episodeUrl")]
        results.sort(key=lambda x: x["releaseDate"], reverse=True)
        for x in results:
            yield {"guid": x.get("episodeGuid") or str(x["trackId"]), "title": x["trackName"], "url": x["episodeUrl"]}
        return
    for item in ET.fromstring(body).iter("item"):
        enc = item.find("enclosure")
        guid = (item.findtext("guid") or "").strip()
        if enc is not None and guid:
            yield {"guid": guid, "title": (item.findtext("title") or "").strip(), "url": direct_url(enc.get("url"))}


def safe_name(guid):
    return re.sub(r"[^A-Za-z0-9_-]", "_", guid)


def process(show, item, out_dir):
    url = item["url"]
    uas = SHOWS[show].get("uas", USER_AGENTS)
    with concurrent.futures.ThreadPoolExecutor(len(uas)) as pool:
        readers = list(pool.map(lambda a: download_hashes(url, a[1], f"copy {a[0] + 1}"), enumerate(uas)))
    readers = [r for r in readers if r and r.crcs]
    if len(readers) < SHOWS[show].get("min_copies", MIN_COPIES):
        raise ValueError(f"only {len(readers)} downloads succeeded")
    m = build_map(readers)
    m = {"guid": item["guid"], "show": show, "title": item["title"], **m}
    (out_dir / f"{safe_name(item['guid'])}.json").write_text(json.dumps(m, separators=(",", ":")) + "\n")
    return m


def summary(m):
    return (f"show {m['frames'] * m['spf'] / m['rate']:.1f}s, {len(m['segs'])} segments, "
            f"ads per copy {m['ads']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shows", nargs="*", default=list(SHOWS), choices=list(SHOWS))
    ap.add_argument("--limit", type=int, default=10, help="newest N episodes per show to make sure have maps")
    ap.add_argument("--max-new", type=int, default=40, help="stop after building this many maps in one run")
    ap.add_argument("--files", nargs="+", help="build one map from local copies instead (testing)")
    ap.add_argument("--guid", help="guid for --files")
    args = ap.parse_args()
    OUT_DIR.mkdir(exist_ok=True)

    if args.files:
        readers = []
        for i, f in enumerate(args.files, 1):
            readers.append(read_file_hashes(f))
            log(f"{i}/{len(args.files)} read {f}")
        m = {"guid": args.guid, "show": "", "title": "", **build_map(readers)}
        (OUT_DIR / f"{safe_name(args.guid)}.json").write_text(json.dumps(m, separators=(",", ":")) + "\n")
        log(summary(m))
        return

    built = failed = 0
    for show in args.shows:
        items = list(feed_items(show))[: args.limit]
        todo = [it for it in items if not (OUT_DIR / f"{safe_name(it['guid'])}.json").exists()]
        log(f"{show}: {len(todo)} of the newest {len(items)} episodes need maps")
        for i, item in enumerate(todo, 1):
            if built >= args.max_new:
                log("reached --max-new; the rest will be done next run")
                break
            log(f"  {i}/{len(todo)}: {item['title']}")
            started = time.time()
            try:
                m = process(show, item, OUT_DIR)
                built += 1
                log(f"    {summary(m)} ({time.time() - started:.0f}s)")
            except Exception as err:
                failed += 1
                log(f"    skipped: {err}")
    log(f"built {built} maps, {failed} failed")
    if failed and not built:
        sys.exit(1)


if __name__ == "__main__":
    main()
