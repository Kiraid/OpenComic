"""OCR a comic into a read-along sidecar for OpenComic.

Finds the text on each page, groups it into speech bubbles, puts the bubbles
in reading order and writes them next to the comic:

    Comic.cbz           -> Comic.cbz.readalong.json
    Comic folder/       -> Comic folder/readalong.json

usage:
    python ocr_comic.py COMIC [--rtl] [--pages 1-20] [--det-side 1280] [--overlays DIR]

--rtl        manga order (right to left)
--pages      only these pages (1-based, in file order); results merge into an
             existing sidecar, so a comic can be processed in chunks
--overlays   also save each page with the bubbles and their order drawn on it

Pipeline: RapidOCR (PP-OCR, ONNX, CPU) finds and reads text lines. Lines are
grouped into bubbles by flood-filling the bubble's interior from each line:
lines in the same filled region, stacked close together, with no narrowing
between them (joined bubbles pinch at the seam) are one bubble. Bubbles are
ordered by panel (gutter-based XY cut), then top to bottom, and left to right
or right to left within a row. Sound effects (big or coloured lettering,
low confidence, very short text) are kept but flagged with "sfx": true.
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import time
import zipfile

import cv2
import numpy as np
from PIL import Image

IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif'}


# --- Text lines -------------------------------------------------------------

def line_boxes(result):
    lines = []
    if result.boxes is None:
        return lines
    for quad, txt, score in zip(result.boxes, result.txts, result.scores):
        xs, ys = quad[:, 0], quad[:, 1]
        lines.append({
            'box': [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())],
            'text': txt,
            'score': float(score),
        })
    return lines


# --- Bubbles ----------------------------------------------------------------

class BubbleFinder:
    """Flood-fills bubble interiors around text lines into a label map.

    A line whose box is already mostly filled by an earlier line joins that
    bubble. Regions that leak into the page (text on art, open captions,
    broken outlines) or are smaller than the line itself are rejected.
    """

    def __init__(self, gray):
        self.gray = gray
        self.labels = np.zeros(gray.shape, np.int32)
        self.boxes = {}
        self.rejected = np.zeros(gray.shape, bool)

    def find(self, box):
        gray = self.gray
        H, W = gray.shape
        x1, y1, x2, y2 = (int(v) for v in box)
        x1, y1 = max(0, x1), max(0, y1)
        crop = gray[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        hit = self.labels[y1:y2, x1:x2]
        hit = hit[hit > 0]
        if hit.size > 0.2 * crop.size:
            return int(np.bincount(hit).argmax())

        bg = float(np.percentile(crop, 90))
        ys, xs = np.nonzero(np.abs(crop.astype(np.int16) - bg) < 12)
        if len(xs) == 0:
            return None
        # Seeds in the padding above/below/beside the letters first; a seed
        # inside a letter's hole (A, B, O...) fills only that hole.
        h, w = crop.shape
        targets = [(w / 2, 1), (w / 2, h - 2), (2, h / 2), (w - 3, h / 2), (w / 2, h / 2)]
        line_area = (x2 - x1) * (y2 - y1)
        flags = 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8)
        for tx, ty in targets:
            k = int(np.argmin((ys - ty) ** 2 + (xs - tx) ** 2))
            sx, sy = int(xs[k] + x1), int(ys[k] + y1)
            if self.rejected[sy, sx]:
                continue
            mask = np.zeros((H + 2, W + 2), np.uint8)
            area, _, _, rect = cv2.floodFill(gray, mask, (sx, sy), 0, 35, 35, flags)
            filled = mask[1:-1, 1:-1]
            if area > 0.12 * H * W:  # leaked into the page: no bubble here
                self.rejected |= filled > 0
                return None
            if area >= line_area:
                break
            self.rejected |= filled > 0  # a letter hole
        else:
            return None

        # Solid bubble: the fill plus the letter holes inside it
        contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        solid = np.zeros_like(filled)
        cv2.drawContours(solid, contours, -1, 255, cv2.FILLED)
        label = len(self.boxes) + 1
        self.labels[solid > 0] = label
        rx, ry, rw, rh = rect
        self.boxes[label] = [int(rx), int(ry), int(rx + rw), int(ry + rh)]
        return label

    def width(self, label, y):
        return int((self.labels[int(y)] == label).sum())

    def pinched(self, label, a, b):
        """Joined bubbles narrow at the seam; one oval doesn't narrow between its lines."""
        top, bottom = (a, b) if a[1] < b[1] else (b, a)
        ya, yb = (top[1] + top[3]) / 2, (bottom[1] + bottom[3]) / 2
        if yb - ya < 2:
            return False
        rows = range(int(top[3]), int(bottom[1]) + 1) if bottom[1] > top[3] else range(int(ya), int(yb))
        narrowest = min(self.width(label, y) for y in rows)
        return narrowest < 0.75 * min(self.width(label, ya), self.width(label, yb))


def group_lines(lines, gray):
    n = len(lines)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    finder = BubbleFinder(gray)
    regions = [finder.find(l['box']) for l in lines]
    for l, r in zip(lines, regions):
        l['area'] = finder.boxes[r] if r else None

    for i in range(n):
        for j in range(i + 1, n):
            a, b = lines[i]['box'], lines[j]['box']
            ra, rb = regions[i], regions[j]
            ha, hb = a[3] - a[1], b[3] - b[1]
            h = min(ha, hb)
            # Different lettering size: a sound effect next to dialogue
            if max(ha, hb) > 1.6 * h or ra != rb:
                continue
            vgap = max(a[1], b[1]) - min(a[3], b[3])
            hgap = max(a[0], b[0]) - min(a[2], b[2])
            stacked = vgap < (0.9 if ra else 0.6) * h and hgap < -0.3 * h
            same_row = vgap < -0.5 * h and hgap < 1.0 * h
            if not (stacked or same_row):
                continue
            if ra and stacked and finder.pinched(ra, a, b):
                continue
            parent[find(i)] = find(j)

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(lines[i])

    # A balloon split into several bubbles (joined balloons) can't highlight
    # as one shape: those bubbles fall back to their text box
    owners = {}
    for root in {find(i) for i in range(n)}:
        for r in {regions[i] for i in range(n) if find(i) == root and regions[i]}:
            owners[r] = owners.get(r, 0) + 1
    for l, r in zip(lines, regions):
        if r and owners[r] > 1:
            l['area'] = None

    bubbles = []
    for members in groups.values():
        members.sort(key=lambda l: (l['box'][1], l['box'][0]))
        areas = [l['area'] for l in members if l['area']]
        bubbles.append({
            'box': [round(min(l['box'][0] for l in members)), round(min(l['box'][1] for l in members)),
                    round(max(l['box'][2] for l in members)), round(max(l['box'][3] for l in members))],
            'area': areas[0] if areas else None,
            'text': join_lines([l['text'] for l in members]),
            'score': round(float(np.mean([l['score'] for l in members])), 3),
            'lineHeight': float(np.median([l['box'][3] - l['box'][1] for l in members])),
        })
    return bubbles


def join_lines(texts):
    """Join bubble lines; a line ending in a hyphenated break joins without a space."""
    out = ''
    for t in texts:
        t = t.strip()
        if out.endswith('-') and not out.endswith('--') and t[:1].isalpha():
            out = out[:-1] + t
        else:
            out = f'{out} {t}' if out else t
    return out


# --- Sound effects ----------------------------------------------------------

def ink_chroma(rgb, gray, box):
    """How coloured the lettering is: dialogue is black/grey, SFX are often coloured."""
    x1, y1, x2, y2 = (int(v) for v in box)
    x1, y1 = max(0, x1), max(0, y1)
    g = gray[y1:y2, x1:x2].astype(np.int16)
    if g.size == 0:
        return 0.0
    # Lettering is the minority: dark on a light bubble, or light on dark art
    dark = g < np.percentile(g, 90) - 60
    light = g > np.percentile(g, 10) + 60
    ink = dark if 0 < dark.sum() <= light.sum() or not light.any() else light
    if not ink.any():
        return 0.0
    px = rgb[y1:y2, x1:x2][ink].astype(np.int16)
    return float((px.max(axis=1) - px.min(axis=1)).mean() / 255)


def mark_sfx(bubbles, rgb, gray):
    if not bubbles:
        return
    # Reference lettering size: bubbles with several words are dialogue
    wordy = [b['lineHeight'] for b in bubbles if len(b['text'].split()) >= 3]
    median_h = float(np.median(wordy or [b['lineHeight'] for b in bubbles]))
    for b in bubbles:
        reasons = []
        if ink_chroma(rgb, gray, b['box']) > 0.3:
            reasons.append('coloured letters')
        if b['lineHeight'] > 1.8 * median_h:
            reasons.append('big letters')
        if b['score'] < 0.75:
            reasons.append('low confidence')
        if len([c for c in b['text'] if c.isalpha()]) < 2:
            reasons.append('too short')
        b['sfx'] = bool(reasons)
        if reasons:
            b['sfxReason'] = reasons


# --- Reading order ----------------------------------------------------------

def gutter_runs(profile, min_len):
    """[start, end) runs where the profile is True for at least min_len."""
    runs, start = [], None
    for i, v in enumerate(list(profile) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                runs.append((start, i))
            start = None
    return runs


def xy_cut(gutter, x1, y1, x2, y2, rtl, depth=0):
    """Split a page region on clean gutter rows, then gutter columns, recursively.

    Returns leaf panels [x1, y1, x2, y2] in reading order.
    """
    region = gutter[y1:y2, x1:x2]
    H, W = gutter.shape
    if depth > 4 or region.size == 0:
        return [[x1, y1, x2, y2]]
    for axis in (1, 0):  # rows first (strips), then columns
        clean = region.mean(axis=axis) > 0.97
        size = clean.shape[0]
        page = H if axis == 1 else W
        runs = gutter_runs(clean, max(4, int(0.006 * page)))
        # Inner gutters only: drop runs touching the region edge
        cuts = [(a + b) // 2 for a, b in runs if a > 0 and b < size]
        # Panels are big: a "gutter" that leaves a sliver is white art or
        # the space between letters
        min_part = (0.08 if axis == 1 else 0.15) * page
        kept, last = [], 0
        for c in cuts:
            if c - last >= min_part and size - c >= min_part:
                kept.append(c)
                last = c
        cuts = kept
        if not cuts:
            continue
        bounds = [0] + cuts + [size]
        parts = []
        for a, b in zip(bounds, bounds[1:]):
            if axis == 1:
                parts.append((x1, y1 + a, x2, y1 + b))
            else:
                parts.append((x1 + a, y1, x1 + b, y2))
        if axis == 0 and rtl:
            parts.reverse()
        panels = []
        for p in parts:
            panels += xy_cut(gutter, *p, rtl, depth + 1)
        return panels
    return [[x1, y1, x2, y2]]


def find_panels(gray, rtl):
    H, W = gray.shape
    edge = np.concatenate([gray[:max(2, H // 100)].ravel(), gray[-max(2, H // 100):].ravel(),
                           gray[:, :max(2, W // 100)].ravel(), gray[:, -max(2, W // 100):].ravel()])
    page = float(np.median(edge))
    gutter = np.abs(gray.astype(np.int16) - page) < 30
    return xy_cut(gutter, 0, 0, W, H, rtl)


def sort_boxes(items, rtl):
    """Pairwise vote like OpenComic's sortBoxes: same row -> by x, else by y."""
    def compare(a, b):
        a, b = a['box'], b['box']
        h = min(a[3] - a[1], b[3] - b[1])
        vover = min(a[3], b[3]) - max(a[1], b[1])
        if vover > 0.5 * h:  # same row
            ax, bx = (a[0] + a[2]) / 2, (b[0] + b[2]) / 2
            before = ax > bx if rtl else ax < bx
        else:
            before = a[1] < b[1]
        return -1 if before else 1

    score = [0] * len(items)
    for i, a in enumerate(items):
        for j, b in enumerate(items):
            if i != j:
                score[i] += compare(a, b)
    return [it for _, it in sorted(zip(score, items), key=lambda p: p[0])]


def order(bubbles, panels, rtl):
    by_panel = [[] for _ in panels]
    for b in bubbles:
        cx, cy = (b['box'][0] + b['box'][2]) / 2, (b['box'][1] + b['box'][3]) / 2
        inside = [i for i, p in enumerate(panels) if p[0] <= cx < p[2] and p[1] <= cy < p[3]]
        best = inside[0] if inside else min(range(len(panels)), key=lambda i: (
            ((panels[i][0] + panels[i][2]) / 2 - cx) ** 2 + ((panels[i][1] + panels[i][3]) / 2 - cy) ** 2))
        b['panel'] = best
        by_panel[best].append(b)
    ordered = []
    for group in by_panel:
        ordered += sort_boxes(group, rtl)
    return ordered


# --- Comic input ------------------------------------------------------------

def natural_key(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', name)]


def list_pages(comic):
    """[(basename, loader)] in file order for a .cbz/.zip or a folder of images."""
    if os.path.isdir(comic):
        names = sorted((n for n in os.listdir(comic) if os.path.splitext(n)[1].lower() in IMAGE_EXT), key=natural_key)
        return [(n, lambda n=n: open(os.path.join(comic, n), 'rb').read()) for n in names]
    if zipfile.is_zipfile(comic):
        z = zipfile.ZipFile(comic)
        infos = [i for i in z.infolist() if not i.is_dir() and os.path.splitext(i.filename)[1].lower() in IMAGE_EXT]
        infos.sort(key=lambda i: natural_key(i.filename))
        return [(os.path.basename(i.filename), lambda i=i: z.read(i)) for i in infos]
    sys.exit(f'unsupported comic (use a .cbz/.zip or a folder): {comic}')


def sidecar_path(comic):
    return os.path.join(comic, 'readalong.json') if os.path.isdir(comic) else comic + '.readalong.json'


def parse_pages(spec, total):
    if not spec:
        return range(total)
    pages = set()
    for part in spec.split(','):
        a, _, b = part.partition('-')
        pages.update(range(int(a) - 1, int(b or a)))
    return sorted(p for p in pages if 0 <= p < total)


# --- Main -------------------------------------------------------------------

def process_page(engine, data, rtl):
    im = Image.open(io.BytesIO(data))
    im.load()
    rgb = np.array(im.convert('RGB'))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    result = engine(rgb[:, :, ::-1])  # RapidOCR takes BGR arrays
    lines = line_boxes(result)
    bubbles = group_lines(lines, gray)
    mark_sfx(bubbles, rgb, gray)
    panels = find_panels(gray, rtl)
    bubbles = order(bubbles, panels, rtl)
    for b in bubbles:
        del b['lineHeight']
    return {'width': im.width, 'height': im.height, 'panels': panels, 'bubbles': bubbles}, rgb


def draw_overlay(rgb, page, out):
    from PIL import ImageDraw, ImageFont
    im = Image.fromarray(rgb)
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype('DejaVuSans-Bold.ttf', max(18, im.width // 45))
    except OSError:
        font = ImageFont.load_default()
    for i, p in enumerate(page['panels']):
        d.rectangle(p, outline=(0, 120, 255), width=5)
    for n, b in enumerate(page['bubbles']):
        color = (160, 160, 160) if b['sfx'] else (230, 20, 60)
        if b['area']:
            d.rectangle(b['area'], outline=(20, 170, 60), width=3)
        d.rectangle(b['box'], outline=color, width=4)
        d.text((b['box'][0] - 8, b['box'][1] - font.size - 4), str(n + 1), fill=color, font=font,
               stroke_width=3, stroke_fill='white')
    im.thumbnail((1200, 1700))
    im.save(out, quality=85)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('comic')
    ap.add_argument('--rtl', action='store_true', help='manga order (right to left)')
    ap.add_argument('--pages', help='e.g. 1-20 or 3,5,7-9 (1-based, file order)')
    ap.add_argument('--det-side', type=int, default=1280, help='text detection size (longest side)')
    ap.add_argument('--overlays', help='folder for debug images of each page')
    ap.add_argument('--out', help='sidecar path (default: next to the comic)')
    args = ap.parse_args()

    from rapidocr import RapidOCR
    engine = RapidOCR(params={
        'Global.use_cls': False,
        'Global.log_level': 'error',
        'Det.limit_type': 'max',
        'Det.limit_side_len': args.det_side,
    })

    out = args.out or sidecar_path(args.comic)
    sidecar = {'version': 1, 'rtl': args.rtl, 'pages': {}}
    if os.path.exists(out):
        prev = json.load(open(out, encoding='utf-8'))
        if prev.get('rtl') == args.rtl:
            sidecar['pages'] = prev.get('pages', {})
    if args.overlays:
        os.makedirs(args.overlays, exist_ok=True)

    pages = list_pages(args.comic)
    todo = parse_pages(args.pages, len(pages))
    t_all = time.time()
    for k, idx in enumerate(todo):
        name, load = pages[idx]
        t = time.time()
        page, rgb = process_page(engine, load(), args.rtl)
        sidecar['pages'][name] = page
        speech = [b for b in page['bubbles'] if not b['sfx']]
        print(f'[{k + 1}/{len(todo)}] p{idx + 1} {name}: {len(speech)} bubbles '
              f'(+{len(page["bubbles"]) - len(speech)} sfx), {len(page["panels"])} panels, {time.time() - t:.1f}s',
              flush=True)
        if args.overlays:
            draw_overlay(rgb, page, os.path.join(args.overlays, f'p{idx + 1:03d}.jpg'))
        # Write as we go so a long run can be stopped and resumed
        with open(out + '.tmp', 'w', encoding='utf-8') as f:
            json.dump(sidecar, f, ensure_ascii=False)
        os.replace(out + '.tmp', out)
    print(f'done: {len(todo)} pages in {time.time() - t_all:.0f}s -> {out}')


if __name__ == '__main__':
    main()
