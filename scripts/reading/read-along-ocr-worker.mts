// Read-along OCR worker: finds the text on a page, groups it into speech
// bubbles and puts them in reading order. A port of tools/read-along/ocr_comic.py.
//
// Runs in a worker started from a hidden iframe (see read-along-ocr.mts), so
// there is no Node here: onnxruntime-web uses its browser WASM backend.
//
// in:  {type: 'init', ortUrl, wasm, det, rec, dict}          -> ready | error
//      {type: 'page', id, rgb, width, height, rtl}            -> page | error

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ort = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

type Box = [number, number, number, number];

interface Line {
	box: Box;
	text: string;
	score: number;
	area: Box | null;
}

interface Bubble {
	box: Box;
	area: Box | null;
	text: string;
	score: number;
	lineHeight: number;
	sfx: boolean;
	sfxReason?: string[];
	panel?: number;
}

interface Image {
	rgb: Uint8Array; // RGB, 3 bytes a pixel
	gray: Uint8Array;
	width: number;
	height: number;
}

const scope = self as unknown as {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onmessage: ((event: MessageEvent) => void) | null;
};

const DET_SIDE = 1280;
const DET_THRESH = 0.3;
const DET_BOX_THRESH = 0.5;
const DET_UNCLIP = 1.6;
const REC_HEIGHT = 48;
const REC_WIDTH = 320;
const TEXT_SCORE = 0.5;

let ort: Ort = null;
let det: Ort = null;
let rec: Ort = null;
let characters: string[] = [];

scope.onmessage = async function(event: MessageEvent) {

	const message = event.data;

	try
	{
		if(message.type === 'init')
		{
			ort = await import(message.ortUrl);
			ort.env.wasm.wasmBinary = message.wasm;
			ort.env.wasm.numThreads = 1; // No SharedArrayBuffer here: one thread per worker

			const options = {executionProviders: ['wasm'], graphOptimizationLevel: 'all'};
			det = await ort.InferenceSession.create(new Uint8Array(message.det), options);
			rec = await ort.InferenceSession.create(new Uint8Array(message.rec), options);

			// CTC classes: blank, the dictionary, then a space
			characters = ['', ...message.dict.split('\n'), ' '];
			scope.postMessage({type: 'ready'});
		}
		else if(message.type === 'page')
		{
			const page = await processPage(new Uint8Array(message.rgb), message.width, message.height, message.rtl);
			scope.postMessage({type: 'page', id: message.id, page});
		}
	}
	catch (error)
	{
		scope.postMessage({type: 'error', id: message.id, message: String((error as Error)?.stack || error)});
	}

};

async function processPage(rgb: Uint8Array, width: number, height: number, rtl: boolean)
{
	const gray = new Uint8Array(width * height);

	for(let i = 0, j = 0; i < gray.length; i++, j += 3)
		gray[i] = Math.round(0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2]);

	const image: Image = {rgb, gray, width, height};

	const lines = await readLines(image);
	const bubbles = groupLines(lines, image);
	markSfx(bubbles, image);
	const panels = findPanels(image, rtl);
	const ordered = order(bubbles, panels, rtl);

	// lineHeight was only for grouping and SFX checks
	for(const bubble of ordered)
		delete (bubble as Partial<Bubble>).lineHeight;

	return {width, height, panels, bubbles: ordered};
}

// --- Text lines -------------------------------------------------------------

// Bilinear sample of an RGB image into a CHW float tensor, channels in BGR
// order (PaddleOCR models are trained on OpenCV's BGR), scaled to [-1, 1]
function toTensor(image: Image, x1: number, y1: number, w: number, h: number, outW: number, outH: number, tensorW = outW): Float32Array
{
	const data = new Float32Array(3 * outH * tensorW);
	const plane = outH * tensorW;
	const sx = w / outW, sy = h / outH;
	const {rgb, width, height} = image;

	for(let oy = 0; oy < outH; oy++)
	{
		const fy = Math.min(Math.max(y1 + (oy + 0.5) * sy - 0.5, 0), height - 1);
		const y0 = Math.floor(fy), y1b = Math.min(y0 + 1, height - 1), dy = fy - y0;

		for(let ox = 0; ox < outW; ox++)
		{
			const fx = Math.min(Math.max(x1 + (ox + 0.5) * sx - 0.5, 0), width - 1);
			const x0 = Math.floor(fx), x1b = Math.min(x0 + 1, width - 1), dx = fx - x0;

			const a = (y0 * width + x0) * 3, b = (y0 * width + x1b) * 3;
			const c = (y1b * width + x0) * 3, d = (y1b * width + x1b) * 3;
			const o = oy * tensorW + ox;

			for(let ch = 0; ch < 3; ch++)
			{
				const v = (rgb[a + ch] * (1 - dx) + rgb[b + ch] * dx) * (1 - dy) + (rgb[c + ch] * (1 - dx) + rgb[d + ch] * dx) * dy;
				data[(2 - ch) * plane + o] = v / 127.5 - 1;
			}
		}
	}

	return data;
}

async function readLines(image: Image): Promise<Line[]>
{
	const lines: Line[] = [];

	for(const box of await detect(image))
	{
		const result = await recognize(image, box);
		if(result.score >= TEXT_SCORE && result.text.trim())
			lines.push({box, text: result.text, score: result.score, area: null});
	}

	return lines;
}

// DB text detection: probability map -> connected regions -> expanded boxes
async function detect(image: Image): Promise<Box[]>
{
	const {width, height} = image;
	const ratio = Math.max(width, height) > DET_SIDE ? DET_SIDE / Math.max(width, height) : 1;
	const h = Math.max(Math.round(height * ratio / 32) * 32, 32);
	const w = Math.max(Math.round(width * ratio / 32) * 32, 32);

	const input = new ort.Tensor('float32', toTensor(image, 0, 0, width, height, w, h), [1, 3, h, w]);
	const output = await det.run({[det.inputNames[0]]: input});
	const pred = output[det.outputNames[0]].data as Float32Array;

	// Threshold, then dilate with a 2x2 kernel
	const bitmap = new Uint8Array(w * h);

	for(let y = 0; y < h; y++)
	{
		for(let x = 0; x < w; x++)
		{
			const i = y * w + x;
			if(pred[i] > DET_THRESH || (x > 0 && pred[i - 1] > DET_THRESH) || (y > 0 && pred[i - w] > DET_THRESH) || (x > 0 && y > 0 && pred[i - w - 1] > DET_THRESH))
				bitmap[i] = 1;
		}
	}

	const boxes: Box[] = [];
	const seen = new Uint8Array(w * h);
	const stack = new Int32Array(w * h);

	for(let start = 0; start < bitmap.length; start++)
	{
		if(!bitmap[start] || seen[start]) continue;

		// 8-connected region
		let top = 0, minX = w, minY = h, maxX = 0, maxY = 0;
		stack[top++] = start;
		seen[start] = 1;

		while(top)
		{
			const i = stack[--top];
			const x = i % w, y = (i - x) / w;
			if(x < minX) minX = x;
			if(x > maxX) maxX = x;
			if(y < minY) minY = y;
			if(y > maxY) maxY = y;

			for(let ny = y - 1; ny <= y + 1; ny++)
			{
				if(ny < 0 || ny >= h) continue;

				for(let nx = x - 1; nx <= x + 1; nx++)
				{
					if(nx < 0 || nx >= w) continue;
					const n = ny * w + nx;
					if(bitmap[n] && !seen[n])
					{
						seen[n] = 1;
						stack[top++] = n;
					}
				}
			}
		}

		const bw = maxX - minX, bh = maxY - minY;
		if(Math.min(bw, bh) < 3) continue;

		// "fast" score: mean probability inside the box
		let sum = 0;
		for(let y = minY; y <= maxY; y++)
			for(let x = minX; x <= maxX; x++)
				sum += pred[y * w + x];

		if(sum / ((bw + 1) * (bh + 1)) < DET_BOX_THRESH) continue;

		// Unclip: grow by area * ratio / perimeter
		const d = bw * bh * DET_UNCLIP / (2 * (bw + bh));
		if(Math.min(bw, bh) + 2 * d < 5) continue;

		const sx = width / w, sy = height / h;
		const box: Box = [
			Math.min(Math.max(Math.round((minX - d) * sx), 0), width),
			Math.min(Math.max(Math.round((minY - d) * sy), 0), height),
			Math.min(Math.max(Math.round((maxX + d) * sx), 0), width),
			Math.min(Math.max(Math.round((maxY + d) * sy), 0), height),
		];

		if(box[2] - box[0] > 3 && box[3] - box[1] > 3)
			boxes.push(box);
	}

	// Top to bottom, then left to right on the same line
	boxes.sort((a, b) => Math.abs(a[1] - b[1]) < 10 ? a[0] - b[0] : a[1] - b[1]);
	return boxes;
}

// CRNN + CTC recognition of one line
async function recognize(image: Image, box: Box): Promise<{text: string; score: number}>
{
	const [x1, y1, x2, y2] = box;
	const w = x2 - x1, h = y2 - y1;
	if(w < 2 || h < 2) return {text: '', score: 0};

	let tensor: Float32Array, tensorW: number;

	if(h / w >= 1.5)
	{
		// Vertical text: rotate the crop 90° counter-clockwise first
		const crop = new Uint8Array(w * h * 3);
		for(let y = 0; y < h; y++)
			for(let x = 0; x < w; x++)
				for(let ch = 0; ch < 3; ch++)
					crop[((w - 1 - x) * h + y) * 3 + ch] = image.rgb[((y1 + y) * image.width + x1 + x) * 3 + ch];

		const rotated: Image = {rgb: crop, gray: new Uint8Array(0), width: h, height: w};
		tensorW = Math.floor(REC_HEIGHT * Math.max(REC_WIDTH / REC_HEIGHT, h / w));
		const outW = Math.min(tensorW, Math.ceil(REC_HEIGHT * h / w));
		tensor = toTensor(rotated, 0, 0, h, w, outW, REC_HEIGHT, tensorW);
	}
	else
	{
		tensorW = Math.floor(REC_HEIGHT * Math.max(REC_WIDTH / REC_HEIGHT, w / h));
		const outW = Math.min(tensorW, Math.ceil(REC_HEIGHT * w / h));
		tensor = toTensor(image, x1, y1, w, h, outW, REC_HEIGHT, tensorW);
	}

	const input = new ort.Tensor('float32', tensor, [1, 3, REC_HEIGHT, tensorW]);
	const output = (await rec.run({[rec.inputNames[0]]: input}))[rec.outputNames[0]];
	const [, steps, classes] = output.dims as number[];
	const probs = output.data as Float32Array;

	let text = '', total = 0, count = 0, last = -1;

	for(let t = 0; t < steps; t++)
	{
		let best = 0, bestProb = -1;
		for(let c = 0, o = t * classes; c < classes; c++)
		{
			if(probs[o + c] > bestProb)
			{
				bestProb = probs[o + c];
				best = c;
			}
		}

		if(best !== 0 && best !== last)
		{
			text += characters[best] ?? '';
			total += bestProb;
			count++;
		}

		last = best;
	}

	return {text, score: count ? total / count : 0};
}

// --- Bubbles ----------------------------------------------------------------

function percentile90(values: Uint8Array | number[]): number
{
	const histogram = new Uint32Array(256);
	for(const v of values) histogram[v]++;

	const rank = 0.9 * (values.length - 1);
	let seen = 0;

	for(let v = 0; v < 256; v++)
	{
		seen += histogram[v];
		if(seen > rank) return v;
	}

	return 255;
}

function crop(gray: Uint8Array, width: number, box: Box): {values: Uint8Array; w: number; h: number}
{
	const [x1, y1, x2, y2] = box;
	const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1);
	const values = new Uint8Array(w * h);

	for(let y = 0; y < h; y++)
		values.set(gray.subarray((y1 + y) * width + x1, (y1 + y) * width + x1 + w), y * w);

	return {values, w, h};
}

// Flood-fills bubble interiors around text lines into a label map. A line
// whose box is already mostly filled by an earlier line joins that bubble.
// Regions that leak into the page (text on art, open captions, broken
// outlines) or are smaller than the line itself are rejected.
class BubbleFinder
{
	labels: Int32Array;
	boxes = new Map<number, Box>();
	rejected: Uint8Array;
	private stamp: Uint32Array;
	private generation = 0;
	private stack: Int32Array;

	constructor(private image: Image)
	{
		const size = image.width * image.height;
		this.labels = new Int32Array(size);
		this.rejected = new Uint8Array(size);
		this.stamp = new Uint32Array(size);
		this.stack = new Int32Array(size);
	}

	// 4-connected fill of pixels within 35 of the seed's value
	private fill(seed: number): {pixels: Int32Array; area: number; rect: Box}
	{
		const {gray, width, height} = this.image;
		const generation = ++this.generation;
		const value = gray[seed];
		const stack = this.stack;
		const pixels: number[] = [];
		let top = 0, minX = width, minY = height, maxX = 0, maxY = 0;

		stack[top++] = seed;
		this.stamp[seed] = generation;

		while(top)
		{
			const i = stack[--top];
			pixels.push(i);
			const x = i % width, y = (i - x) / width;
			if(x < minX) minX = x;
			if(x > maxX) maxX = x;
			if(y < minY) minY = y;
			if(y > maxY) maxY = y;

			const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];

			for(const n of neighbours)
			{
				if(n < 0 || this.stamp[n] === generation) continue;
				if(Math.abs(gray[n] - value) > 35) continue;
				this.stamp[n] = generation;
				stack[top++] = n;
			}
		}

		return {pixels: Int32Array.from(pixels), area: pixels.length, rect: [minX, minY, maxX + 1, maxY + 1]};
	}

	find(box: Box): number | null
	{
		const {gray, width, height} = this.image;
		const x1 = Math.max(0, Math.floor(box[0])), y1 = Math.max(0, Math.floor(box[1]));
		const x2 = Math.min(width, Math.floor(box[2])), y2 = Math.min(height, Math.floor(box[3]));
		const w = x2 - x1, h = y2 - y1;
		if(w <= 0 || h <= 0) return null;

		// Already filled by an earlier line of the same bubble?
		const counts = new Map<number, number>();
		let hit = 0;

		for(let y = y1; y < y2; y++)
		{
			for(let x = x1; x < x2; x++)
			{
				const label = this.labels[y * width + x];
				if(label > 0)
				{
					hit++;
					counts.set(label, (counts.get(label) || 0) + 1);
				}
			}
		}

		if(hit > 0.2 * w * h)
			return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

		const {values} = crop(gray, width, [x1, y1, x2, y2]);
		const bg = percentile90(values);
		const candidates: number[] = [];

		for(let i = 0; i < values.length; i++)
			if(Math.abs(values[i] - bg) < 12) candidates.push(i);

		if(!candidates.length) return null;

		// Seeds in the padding above/below/beside the letters first; a seed
		// inside a letter's hole (A, B, O...) fills only that hole.
		const targets = [[w / 2, 1], [w / 2, h - 2], [2, h / 2], [w - 3, h / 2], [w / 2, h / 2]];
		let filled: ReturnType<BubbleFinder['fill']> | null = null;

		for(const [tx, ty] of targets)
		{
			let best = candidates[0], bestDistance = Infinity;

			for(const c of candidates)
			{
				const cx = c % w, cy = (c - cx) / w;
				const distance = (cy - ty) ** 2 + (cx - tx) ** 2;
				if(distance < bestDistance)
				{
					bestDistance = distance;
					best = c;
				}
			}

			const seed = (y1 + (best - best % w) / w) * width + x1 + best % w;
			if(this.rejected[seed]) continue;

			const region = this.fill(seed);

			if(region.area > 0.12 * width * height) // Leaked into the page: no bubble here
			{
				for(const i of region.pixels) this.rejected[i] = 1;
				return null;
			}

			if(region.area >= w * h)
			{
				filled = region;
				break;
			}

			for(const i of region.pixels) this.rejected[i] = 1; // A letter hole
		}

		if(!filled) return null;

		// Solid bubble: the fill plus the letter holes inside it. Everything in
		// the region's bounds that the outside can't reach is inside.
		const [rx1, ry1, rx2, ry2] = filled.rect;
		const rw = rx2 - rx1, rh = ry2 - ry1;
		const inRegion = new Uint8Array(rw * rh);
		for(const i of filled.pixels) inRegion[(Math.floor(i / width) - ry1) * rw + (i % width) - rx1] = 1;

		const outside = new Uint8Array(rw * rh);
		const stack: number[] = [];

		for(let x = 0; x < rw; x++)
		{
			stack.push(x, (rh - 1) * rw + x);
		}

		for(let y = 0; y < rh; y++)
		{
			stack.push(y * rw, y * rw + rw - 1);
		}

		while(stack.length)
		{
			const i = stack.pop()!;
			if(outside[i] || inRegion[i]) continue;
			outside[i] = 1;
			const x = i % rw, y = (i - x) / rw;
			if(x > 0) stack.push(i - 1);
			if(x < rw - 1) stack.push(i + 1);
			if(y > 0) stack.push(i - rw);
			if(y < rh - 1) stack.push(i + rw);
		}

		const label = this.boxes.size + 1;

		for(let y = 0; y < rh; y++)
			for(let x = 0; x < rw; x++)
				if(!outside[y * rw + x]) this.labels[(ry1 + y) * width + rx1 + x] = label;

		this.boxes.set(label, filled.rect);
		return label;
	}

	width(label: number, y: number): number
	{
		const row = Math.floor(y) * this.image.width;
		let count = 0;
		for(let x = 0; x < this.image.width; x++)
			if(this.labels[row + x] === label) count++;
		return count;
	}

	// Joined bubbles narrow at the seam; one oval doesn't narrow between its lines
	pinched(label: number, a: Box, b: Box): boolean
	{
		const [top, bottom] = a[1] < b[1] ? [a, b] : [b, a];
		const ya = (top[1] + top[3]) / 2, yb = (bottom[1] + bottom[3]) / 2;
		if(yb - ya < 2) return false;

		const [from, to] = bottom[1] > top[3] ? [Math.floor(top[3]), Math.floor(bottom[1]) + 1] : [Math.floor(ya), Math.floor(yb)];
		let narrowest = Infinity;
		for(let y = from; y < to; y++) narrowest = Math.min(narrowest, this.width(label, y));

		return narrowest < 0.75 * Math.min(this.width(label, ya), this.width(label, yb));
	}
}

// Lines share a bubble when they flood-fill to the same region, sit close
// together and the bubble doesn't pinch between them
function groupLines(lines: Line[], image: Image): Bubble[]
{
	const n = lines.length;
	const parent = lines.map((_line, i) => i);

	const find = (i: number): number => {

		while(parent[i] !== i)
		{
			parent[i] = parent[parent[i]];
			i = parent[i];
		}

		return i;

	};

	const finder = new BubbleFinder(image);
	const regions = lines.map(line => finder.find(line.box));
	lines.forEach((line, i) => line.area = regions[i] ? finder.boxes.get(regions[i]!)! : null);

	for(let i = 0; i < n; i++)
	{
		for(let j = i + 1; j < n; j++)
		{
			const a = lines[i].box, b = lines[j].box;
			const ra = regions[i], rb = regions[j];
			const ha = a[3] - a[1], hb = b[3] - b[1];
			const h = Math.min(ha, hb);

			// Different lettering size: a sound effect next to dialogue
			if(Math.max(ha, hb) > 1.6 * h || ra !== rb) continue;

			const vgap = Math.max(a[1], b[1]) - Math.min(a[3], b[3]);
			const hgap = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
			const stacked = vgap < (ra ? 0.9 : 0.6) * h && hgap < -0.3 * h;
			const sameRow = vgap < -0.5 * h && hgap < 1.0 * h;

			if(!(stacked || sameRow)) continue;
			if(ra && stacked && finder.pinched(ra, a, b)) continue;

			parent[find(i)] = find(j);
		}
	}

	// A balloon split into several bubbles (joined balloons) can't highlight
	// as one shape: those bubbles fall back to their text box
	const owners = new Map<number, Set<number>>();
	lines.forEach((_line, i) => {

		if(!regions[i]) return;
		if(!owners.has(regions[i]!)) owners.set(regions[i]!, new Set());
		owners.get(regions[i]!)!.add(find(i));

	});

	lines.forEach((line, i) => {

		if(regions[i] && owners.get(regions[i]!)!.size > 1) line.area = null;

	});

	const groups = new Map<number, Line[]>();
	lines.forEach((line, i) => {

		const root = find(i);
		if(!groups.has(root)) groups.set(root, []);
		groups.get(root)!.push(line);

	});

	const bubbles: Bubble[] = [];

	for(const members of groups.values())
	{
		members.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
		const heights = members.map(line => line.box[3] - line.box[1]).sort((a, b) => a - b);
		const middle = heights.length >> 1;

		bubbles.push({
			box: [
				Math.round(Math.min(...members.map(line => line.box[0]))),
				Math.round(Math.min(...members.map(line => line.box[1]))),
				Math.round(Math.max(...members.map(line => line.box[2]))),
				Math.round(Math.max(...members.map(line => line.box[3]))),
			],
			area: members.find(line => line.area)?.area ?? null,
			text: joinLines(members.map(line => line.text)),
			score: Math.round(members.reduce((sum, line) => sum + line.score, 0) / members.length * 1000) / 1000,
			lineHeight: heights.length % 2 ? heights[middle] : (heights[middle - 1] + heights[middle]) / 2,
			sfx: false,
		});
	}

	return bubbles;
}

// Join bubble lines; a line ending in a hyphenated break joins without a space
function joinLines(texts: string[]): string
{
	let out = '';

	for(let text of texts)
	{
		text = text.trim();

		if(out.endsWith('-') && !out.endsWith('--') && /^\p{L}/u.test(text))
			out = out.slice(0, -1) + text;
		else
			out = out ? `${out} ${text}` : text;
	}

	return out;
}

// --- Sound effects ----------------------------------------------------------

// How coloured the lettering is: dialogue is black/grey, SFX are often coloured
function inkChroma(image: Image, box: Box): number
{
	const {values, w, h} = crop(image.gray, image.width, box);
	if(!values.length) return 0;

	const sorted = Uint8Array.from(values).sort();
	const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
	const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))];

	// Lettering is the minority: dark on a light bubble, or light on dark art
	let dark = 0, light = 0;
	for(const v of values)
	{
		if(v < p90 - 60) dark++;
		if(v > p10 + 60) light++;
	}

	const useDark = (dark > 0 && dark <= light) || light === 0;
	let total = 0, count = 0;

	for(let y = 0; y < h; y++)
	{
		for(let x = 0; x < w; x++)
		{
			const v = values[y * w + x];
			if(useDark ? v < p90 - 60 : v > p10 + 60)
			{
				const o = ((box[1] + y) * image.width + box[0] + x) * 3;
				const r = image.rgb[o], g = image.rgb[o + 1], b = image.rgb[o + 2];
				total += Math.max(r, g, b) - Math.min(r, g, b);
				count++;
			}
		}
	}

	return count ? total / count / 255 : 0;
}

function markSfx(bubbles: Bubble[], image: Image): void
{
	if(!bubbles.length) return;

	// Reference lettering size: bubbles with several words are dialogue
	const wordy = bubbles.filter(bubble => bubble.text.split(/\s+/).length >= 3).map(bubble => bubble.lineHeight);
	const heights = (wordy.length ? wordy : bubbles.map(bubble => bubble.lineHeight)).sort((a, b) => a - b);
	const middle = heights.length >> 1;
	const median = heights.length % 2 ? heights[middle] : (heights[middle - 1] + heights[middle]) / 2;

	for(const bubble of bubbles)
	{
		const reasons: string[] = [];

		if(inkChroma(image, bubble.box) > 0.3) reasons.push('coloured letters');
		if(bubble.lineHeight > 1.8 * median) reasons.push('big letters');
		if(bubble.score < 0.75) reasons.push('low confidence');
		if([...bubble.text].filter(c => /\p{L}/u.test(c)).length < 2) reasons.push('too short');

		bubble.sfx = reasons.length > 0;
		if(reasons.length) bubble.sfxReason = reasons;
	}
}

// --- Reading order ----------------------------------------------------------

// [start, end) runs where the profile is true for at least minLength
function gutterRuns(profile: boolean[], minLength: number): [number, number][]
{
	const runs: [number, number][] = [];
	let start = -1;

	for(let i = 0; i <= profile.length; i++)
	{
		const v = i < profile.length && profile[i];

		if(v && start < 0)
		{
			start = i;
		}
		else if(!v && start >= 0)
		{
			if(i - start >= minLength) runs.push([start, i]);
			start = -1;
		}
	}

	return runs;
}

// Split a page region on clean gutter rows, then gutter columns, recursively.
// Returns leaf panels in reading order.
function xyCut(gutter: Uint8Array, width: number, height: number, x1: number, y1: number, x2: number, y2: number, rtl: boolean, depth = 0): Box[]
{
	if(depth > 4 || x2 <= x1 || y2 <= y1) return [[x1, y1, x2, y2]];

	for(const axis of ['rows', 'columns'] as const)
	{
		const size = axis === 'rows' ? y2 - y1 : x2 - x1;
		const span = axis === 'rows' ? x2 - x1 : y2 - y1;
		const page = axis === 'rows' ? height : width;
		const clean: boolean[] = [];

		for(let k = 0; k < size; k++)
		{
			let sum = 0;

			for(let m = 0; m < span; m++)
				sum += axis === 'rows' ? gutter[(y1 + k) * width + x1 + m] : gutter[(y1 + m) * width + x1 + k];

			clean.push(sum / span > 0.97);
		}

		const runs = gutterRuns(clean, Math.max(4, Math.floor(0.006 * page)));

		// Inner gutters only; a "gutter" that leaves a sliver is white art or
		// the space between letters
		const minPart = (axis === 'rows' ? 0.08 : 0.15) * page;
		const cuts: number[] = [];
		let last = 0;

		for(const [a, b] of runs)
		{
			if(a <= 0 || b >= size) continue;
			const cut = (a + b) >> 1;

			if(cut - last >= minPart && size - cut >= minPart)
			{
				cuts.push(cut);
				last = cut;
			}
		}

		if(!cuts.length) continue;

		const bounds = [0, ...cuts, size];
		let parts: Box[] = [];

		for(let k = 0; k < bounds.length - 1; k++)
		{
			parts.push(axis === 'rows' ? [x1, y1 + bounds[k], x2, y1 + bounds[k + 1]] : [x1 + bounds[k], y1, x1 + bounds[k + 1], y2]);
		}

		if(axis === 'columns' && rtl) parts = parts.reverse();

		return parts.flatMap(part => xyCut(gutter, width, height, ...part, rtl, depth + 1));
	}

	return [[x1, y1, x2, y2]];
}

function findPanels(image: Image, rtl: boolean): Box[]
{
	const {gray, width, height} = image;
	const edge: number[] = [];
	const ey = Math.max(2, Math.floor(height / 100)), ex = Math.max(2, Math.floor(width / 100));

	for(let y = 0; y < height; y++)
	{
		for(let x = 0; x < width; x++)
		{
			if(y < ey || y >= height - ey || x < ex || x >= width - ex)
				edge.push(gray[y * width + x]);
		}
	}

	edge.sort((a, b) => a - b);
	const pageColor = edge[edge.length >> 1];

	const gutter = new Uint8Array(width * height);
	for(let i = 0; i < gutter.length; i++) gutter[i] = Math.abs(gray[i] - pageColor) < 30 ? 1 : 0;

	return xyCut(gutter, width, height, 0, 0, width, height, rtl);
}

// Pairwise vote like OpenComic's sortBoxes: same row -> by x, else by y
function sortBoxes(items: Bubble[], rtl: boolean): Bubble[]
{
	const compare = (a: Box, b: Box): number => {

		const h = Math.min(a[3] - a[1], b[3] - b[1]);
		const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
		let before: boolean;

		if(overlap > 0.5 * h) // Same row
		{
			const ax = (a[0] + a[2]) / 2, bx = (b[0] + b[2]) / 2;
			before = rtl ? ax > bx : ax < bx;
		}
		else
		{
			before = a[1] < b[1];
		}

		return before ? -1 : 1;

	};

	const scores = items.map((a, i) => items.reduce((sum, b, j) => i === j ? sum : sum + compare(a.box, b.box), 0));
	return items.map((item, i) => ({item, score: scores[i]})).sort((a, b) => a.score - b.score).map(v => v.item);
}

function order(bubbles: Bubble[], panels: Box[], rtl: boolean): Bubble[]
{
	const byPanel: Bubble[][] = panels.map(() => []);

	for(const bubble of bubbles)
	{
		const cx = (bubble.box[0] + bubble.box[2]) / 2, cy = (bubble.box[1] + bubble.box[3]) / 2;
		let best = panels.findIndex(p => p[0] <= cx && cx < p[2] && p[1] <= cy && cy < p[3]);

		if(best < 0)
		{
			let bestDistance = Infinity;
			panels.forEach((p, i) => {

				const distance = ((p[0] + p[2]) / 2 - cx) ** 2 + ((p[1] + p[3]) / 2 - cy) ** 2;
				if(distance < bestDistance)
				{
					bestDistance = distance;
					best = i;
				}

			});
		}

		bubble.panel = best;
		byPanel[best].push(bubble);
	}

	return byPanel.flatMap(group => sortBoxes(group, rtl));
}
