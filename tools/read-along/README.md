# Read-along OCR

The app can now do this itself: right-click a comic or folder in the library
and choose **Make read-along**, or use the voice button in the reader. This
script is the original Python prototype, still handy for batch runs or
debugging (`--overlays`).

`ocr_comic.py` finds the speech bubbles in a comic, reads them, puts them in
reading order and writes a sidecar file next to the comic. OpenComic picks it
up when the comic is opened and shows the read-along bar (prev / play / next,
speed, voice, sound effects; keys R, J, K).

| Comic | Sidecar |
|---|---|
| `Comic.cbz` | `Comic.cbz.readalong.json` |
| `Comic folder\` | `Comic folder\readalong.json` |

Pages are keyed by their path inside the comic (`09.jpg`, or `001/09.jpg` for
chapter folders), so a sidecar made on one machine works on another: copy it
next to the same comic.

## Setup

Python 3.10–3.12, then from this folder:

```
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt      (Windows)
.venv/bin/pip install -r requirements.txt          (Linux / WSL)
```

## Use

```
python ocr_comic.py "D:\Berserk v41.cbz" --rtl --pages 1-40
python ocr_comic.py "D:\Sandman 001.cbz"
```

- `--rtl` for manga (right-to-left order); leave it out for western comics.
- `--pages 1-40` or `3,5,7-9` processes part of the book; later runs merge into
  the same sidecar, so a book can be done in chunks.
- `--overlays DIR` saves each page with the bubbles and their order drawn on it,
  to check the result.

Runs on the CPU: about 2–5 s a page on a 4-core laptop. Only `.cbz`/`.zip`
and image folders are read (not `.cbr`).

## Known gaps

- Irregular layouts (inset panels, circles, art without gutters) can come out
  in the wrong order.
- Comic lettering sometimes loses spaces ("WEDIDIT").
- Small floating sound effects (e.g. "CLAP") are read as dialogue; big or
  coloured ones are skipped.
