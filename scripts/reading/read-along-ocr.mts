import p from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import url from 'url';
import crypto from 'crypto';
import sharp from 'sharp';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const appDir: any;
declare const events: any;
declare const language: any;
declare const reading: any;
declare const compatible: any;
declare const fileManager: any;
declare const electronRemote: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Makes read-along sidecars inside the app: lists a comic's pages through
// OpenComic's file manager (CBZ, CBR, folders...), runs OCR in a small pool
// of workers (read-along-ocr-worker.mts) and writes <comic>.readalong.json.
// The two PP-OCRv6 models download on first use.

interface Model {
	file: string;
	url: string;
	sha256: string;
}

const MODELS: Model[] = [
	{
		file: 'PP-OCRv6_det_small.onnx',
		url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx',
		sha256: '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f',
	},
	{
		file: 'PP-OCRv6_rec_small.onnx',
		url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx',
		sha256: '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
	},
];

interface Page {
	name: string;
	path: string;
}

interface Comic {
	path: string;
	name: string;
	pages: Page[];
	sidecar: string;
}

interface Job {
	title: string;
	rtl: boolean;
	done: number;
	total: number;
	bubbles: number;
	started: number;
	cancelled: boolean;
	status: string;
}

interface PoolWorker {
	worker: Worker;
	resolve: ((value: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
	reject: ((error: Error) => void) | null;
}

let job: Job | null = null;
let stopPool: (() => void) | null = null;
let pending: {paths: string[]; folder: string | false} | null = null;

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'})[c]!);
const fileUrl = (path: string) => url.pathToFileURL(path).href;
const toArrayBuffer = (buffer: Buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

// --- Which comics -----------------------------------------------------------

function sidecarFor(path: string): string
{
	return fs.statSync(path).isDirectory() ? p.join(path, 'readalong.json') : path + '.readalong.json';
}

// Local comic files and folders only: sidecars are written next to them
function supported(path: string): boolean
{
	if(!path || fileManager.isServer(path) || fileManager.isOpds?.(path)) return false;
	if(fileManager.lastCompressedFile(p.dirname(path))) return false; // Inside an archive
	if(/\.(pdf|epub|mobi|fb2)$/i.test(path)) return false;

	try
	{
		return compatible.compressed(path) || fs.statSync(path).isDirectory();
	}
	catch
	{
		return false;
	}
}

// A folder that is itself a comic: page images directly inside
function hasPages(folder: string): boolean
{
	try
	{
		return fs.readdirSync(folder).some(name => compatible.image(name));
	}
	catch
	{
		return false;
	}
}

// Comic archives anywhere under a folder
function comicsInFolder(folder: string, depth = 0): string[]
{
	const found: string[] = [];

	for(const entry of fs.readdirSync(folder, {withFileTypes: true}))
	{
		const path = p.join(folder, entry.name);

		if(entry.isDirectory() && depth < 4)
			found.push(...comicsInFolder(path, depth + 1));
		else if(entry.isFile() && compatible.compressed(path) && !/\.(pdf|epub)$/i.test(path))
			found.push(path);
	}

	return found.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
}

async function listPages(path: string): Promise<Page[]>
{
	const file = fileManager.file(path);
	const pages: Page[] = [];

	const walk = async(dir: string) => {

		for(const entry of await file.read({}, dir))
		{
			if(entry.folder)
				await walk(entry.path);
			else if(!entry.compressed && compatible.image(entry.path))
				pages.push({name: entry.name, path: entry.path});
		}

	};

	try
	{
		await walk(path);
	}
	finally
	{
		file.destroy();
	}

	return pages;
}

// --- Dialog -----------------------------------------------------------------

function dialog(paths: string[], folder: string | false = false): void
{
	// Library items carry their paths with escaped (doubled) backslashes
	const comics = paths.map(path => p.normalize(path)).filter(supported);

	if(!comics.length)
	{
		events.snackbar({key: 'readAlongOcr', text: 'Read-along works with local comic files and folders.', duration: 5});
		return;
	}

	if(job)
	{
		events.snackbar({key: 'readAlongOcr', text: 'Already making a read-along. Wait for it to finish, or stop it first.', duration: 5});
		return;
	}

	pending = {paths: comics, folder};

	const done = comics.filter(path => fs.existsSync(sidecarFor(path))).length;
	const firstRun = !MODELS.every(model => fs.existsSync(p.join(modelsDir(), model.file)));

	const what = folder ? `the <b>${comics.length} comic${comics.length === 1 ? '' : 's'}</b> in <b>${escape(p.basename(folder))}</b>` : `<b>${escape(p.basename(comics[0]).replace(/\.[^.]+$/, ''))}</b>`;

	const content = `
		<p>Finds the speech bubbles in ${what} and reads their text, so you can follow along and listen while you read.</p>
		<p>It runs on this PC and takes a few minutes${folder ? ' per comic' : ''}. You can keep reading meanwhile.${firstRun ? ' The first time it also downloads the text models (31 MB).' : ''}${done ? (folder ? ` ${done} already ${done === 1 ? 'has' : 'have'} a read-along: ${done === 1 ? 'it keeps its' : 'they keep their'} direction and only missing pages are added.` : ' Pages that already have a read-along are skipped.') : ''}</p>
		<p><b>Comic or manga?</b> Manga is read right to left.</p>
	`;

	events.dialog({
		header: 'Make read-along',
		width: 420,
		height: false,
		content,
		buttons: [
			{text: 'Cancel', function: 'events.closeDialog();'},
			{text: 'Comic', function: 'events.closeDialog(); reading.readAlongOcr.confirm(false);'},
			{text: 'Manga', function: 'events.closeDialog(); reading.readAlongOcr.confirm(true);'},
		],
	});
}

function dialogFolder(folder: string): void
{
	folder = p.normalize(folder);
	let comics: string[] = [];

	try
	{
		comics = comicsInFolder(folder);
	}
	catch (error)
	{
		console.error(error);
	}

	if(!comics.length)
	{
		events.snackbar({key: 'readAlongOcr', text: 'No CBZ or CBR comics in this folder.', duration: 5});
		return;
	}

	dialog(comics, folder);
}

// The comic open in the reader
function dialogCurrent(): void
{
	const path = reading.readAlong.path;
	if(path) dialog([path]);
}

function confirm(rtl: boolean): void
{
	if(!pending) return;

	const {paths, folder} = pending;
	pending = null;

	run(paths, rtl, folder ? p.basename(folder) : p.basename(paths[0]).replace(/\.[^.]+$/, ''), folder !== false).catch(error => console.error(error));
}

// --- Models -----------------------------------------------------------------

function modelsDir(): string
{
	return p.join(electronRemote.app.getPath('userData'), 'read-along', 'models');
}

async function ensureModels(): Promise<ArrayBuffer[]>
{
	const dir = modelsDir();
	await fsp.mkdir(dir, {recursive: true});

	const buffers: ArrayBuffer[] = [];
	const missing = MODELS.filter(model => !fs.existsSync(p.join(dir, model.file)));
	let downloaded = 0;

	for(const model of MODELS)
	{
		const path = p.join(dir, model.file);

		if(!fs.existsSync(path))
		{
			const response = await fetch(model.url);
			if(!response.ok || !response.body) throw new Error(`Couldn't download ${model.file} (${response.status})`);

			const total = +(response.headers.get('content-length') || 0);
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let loaded = 0;

			for(;;)
			{
				const {done, value} = await reader.read();
				if(done) break;
				if(job?.cancelled) throw new Error('cancelled');

				chunks.push(value);
				loaded += value.length;
				setStatus(`Downloading text models (${downloaded + 1} of ${missing.length})` + (total ? ` · ${Math.round(loaded / total * 100)}%` : ''));
			}

			const data = Buffer.concat(chunks);

			if(crypto.createHash('sha256').update(data).digest('hex') !== model.sha256)
				throw new Error(`${model.file} didn't download correctly (checksum mismatch)`);

			await fsp.writeFile(path + '.tmp', data);
			await fsp.rename(path + '.tmp', path);
			downloaded++;
		}

		buffers.push(toArrayBuffer(await fsp.readFile(path)));
	}

	return buffers;
}

// --- Workers ----------------------------------------------------------------

async function startPool(size: number, models: ArrayBuffer[]): Promise<{workers: PoolWorker[]; stop: () => void}>
{
	const frame = document.createElement('iframe');
	frame.className = 'read-along-ocr-frame';
	frame.style.display = 'none';

	const ready = new Promise<void>((resolve) => {

		const listener = (event: MessageEvent) => {

			if(event.source !== frame.contentWindow || !event.data?.ocrFrameReady) return;

			window.removeEventListener('message', listener);
			resolve();

		};

		window.addEventListener('message', listener);

	});

	frame.src = fileUrl(p.join(appDir, 'vendor/ocr/ocr-frame.html'));
	document.body.appendChild(frame);
	await ready;

	// The frame's Worker constructor starts workers without Node integration
	const realm = frame.contentWindow as Window & typeof globalThis;
	const wasm = toArrayBuffer(await fsp.readFile(p.join(appDir, 'vendor/ocr/ort-wasm-simd-threaded.wasm')));
	const dict = await fsp.readFile(p.join(appDir, 'vendor/ocr/ppocrv6-dict.txt'), 'utf8');
	const workers: PoolWorker[] = [];

	for(let i = 0; i < size; i++)
	{
		const poolWorker: PoolWorker = {
			worker: new realm.Worker(fileUrl(p.join(appDir, '.dist/reading/read-along-ocr-worker.mjs')), {type: 'module'}),
			resolve: null,
			reject: null,
		};

		poolWorker.worker.onmessage = (event: MessageEvent) => {

			if(event.data.type === 'error')
				poolWorker.reject?.(new Error(event.data.message));
			else
				poolWorker.resolve?.(event.data);

		};

		poolWorker.worker.onerror = (event: ErrorEvent) => poolWorker.reject?.(new Error(event.message || 'OCR worker failed'));
		workers.push(poolWorker);
	}

	await Promise.all(workers.map(poolWorker => send(poolWorker, {
		type: 'init',
		ortUrl: fileUrl(p.join(appDir, 'vendor/ocr/ort.wasm.bundle.min.mjs')),
		wasm: wasm.slice(0),
		det: models[0].slice(0),
		rec: models[1].slice(0),
		dict,
	})));

	return {
		workers,
		// Ends the workers at once: pages in progress are dropped (and redone next run)
		stop: () => {

			workers.forEach((poolWorker) => {

				poolWorker.worker.terminate();
				poolWorker.reject?.(new Error('cancelled'));

			});

			frame.remove();

		},
	};
}

function send(poolWorker: PoolWorker, message: unknown, transfer: Transferable[] = []): Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
{
	return new Promise((resolve, reject) => {

		poolWorker.resolve = resolve;
		poolWorker.reject = reject;
		poolWorker.worker.postMessage(message, transfer);

	});
}

// --- Running ----------------------------------------------------------------

// keepDirection: an existing sidecar keeps its own direction (folder runs mix
// comics and manga); otherwise a different direction starts it over
async function readSidecar(path: string, rtl: boolean, keepDirection: boolean)
{
	try
	{
		const sidecar = JSON.parse(await fsp.readFile(path, 'utf8'));
		if(sidecar.rtl === rtl || keepDirection) return sidecar;
	}
	catch
	{
		// None yet, or unreadable: start a new one
	}

	return {version: 1, rtl, pages: {}};
}

async function writeSidecar(path: string, sidecar: unknown): Promise<void>
{
	await fsp.writeFile(path + '.tmp', JSON.stringify(sidecar));
	await fsp.rename(path + '.tmp', path);
}

async function run(paths: string[], rtl: boolean, title: string, keepDirection: boolean): Promise<void>
{
	job = {title, rtl, done: 0, total: 0, bubbles: 0, started: Date.now(), cancelled: false, status: 'Starting…'};
	showProgress();

	let pool: Awaited<ReturnType<typeof startPool>> | null = null;

	try
	{
		setStatus('Reading the comic files…');
		const comics: Comic[] = [];

		for(const path of paths)
		{
			const pages = await listPages(path);
			comics.push({path, name: p.basename(path), pages, sidecar: sidecarFor(path)});
		}

		const models = await ensureModels();
		const size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
		setStatus('Loading the text models…');
		pool = await startPool(size, models);
		stopPool = pool.stop;
		if(job.cancelled) throw new Error('cancelled');

		// Pages already in a sidecar (same direction) are kept
		const work: {comic: Comic; sidecar: any; pages: Page[]}[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

		for(const comic of comics)
		{
			const sidecar = await readSidecar(comic.sidecar, rtl, keepDirection);
			const pages = comic.pages.filter(page => !sidecar.pages[page.name]);
			work.push({comic, sidecar, pages});
			job.total += pages.length;
		}

		job.started = Date.now();
		setStatus('');

		for(const {comic, sidecar, pages} of work)
		{
			if(job.cancelled) break;
			if(!pages.length) continue;

			await runComic(comic, sidecar, pages, sidecar.rtl, pool.workers);
			await writeSidecar(comic.sidecar, sidecar);
			reloadIfOpen(comic.path);
		}

		finish(job.cancelled ? 'Stopped. Pages done so far are saved; run it again to finish.' : `Done: ${job.done} pages, ${job.bubbles} bubbles.`);
	}
	catch (error)
	{
		console.error(error);
		finish(job?.cancelled ? 'Stopped.' : `Couldn't finish: ${(error as Error).message}`, true);
	}
	finally
	{
		pool?.stop();
		stopPool = null;
		job = null;
	}
}

async function runComic(comic: Comic, sidecar: any, pages: Page[], rtl: boolean, workers: PoolWorker[]): Promise<void> // eslint-disable-line @typescript-eslint/no-explicit-any
{
	const file = fileManager.file(comic.path);
	let next = 0;
	let extracted = 0;
	let extracting: Promise<void> | null = null;
	let sinceSave = 0;

	// Extract pages in batches: one call to the archive tool per batch
	const ensureExtracted = async(index: number) => {

		while(index >= extracted)
		{
			if(!extracting)
			{
				const batch = pages.slice(extracted, extracted + 12);

				// A failed batch still moves on: its pages fail to decode and are skipped
				extracting = file.makeAvailable(batch.map(page => ({path: page.path}))).catch((error: Error) => console.error(error)).then(() => {

					extracted += batch.length;
					extracting = null;

				});
			}

			await extracting;
		}

	};

	const loop = async(poolWorker: PoolWorker) => {

		while(!job!.cancelled && next < pages.length)
		{
			const index = next++;
			const page = pages[index];

			try
			{
				await ensureExtracted(index);
				const realPath = fileManager.realPath(page.path, -1);
				const {data, info} = await sharp(realPath).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject: true});
				const rgb = toArrayBuffer(data);
				const result = await send(poolWorker, {type: 'page', id: index, rgb, width: info.width, height: info.height, rtl}, [rgb]);

				sidecar.pages[page.name] = result.page;
				job!.bubbles += result.page.bubbles.filter((bubble: {sfx: boolean}) => !bubble.sfx).length;
			}
			catch (error)
			{
				if(job!.cancelled) break;
				console.error(`Read-along OCR: ${page.path}`, error);
			}

			job!.done++;
			updateProgress();

			// Save as it goes so stopping keeps the work
			if(++sinceSave >= 6)
			{
				sinceSave = 0;
				await writeSidecar(comic.sidecar, sidecar);
			}
		}

	};

	try
	{
		await Promise.all(workers.map(loop));
	}
	finally
	{
		file.destroy();
	}
}

// The comic open in the reader just got (more of) its read-along
function reloadIfOpen(path: string): void
{
	if(reading.readAlong.path !== path) return;

	reading.readAlong.load(path);

	for(const button of document.querySelectorAll('.button-reading-read-along'))
	{
		button.setAttribute('onclick', 'reading.readAlong.toggleMode();');
		button.setAttribute('hover-text', reading.readAlong.enabled() ? language.reading.readAlong.turnOff : language.reading.readAlong.main);
		button.classList.toggle('fill', reading.readAlong.enabled());
	}
}

function cancel(): void
{
	if(job)
	{
		job.cancelled = true;
		setStatus('Stopping…');
		stopPool?.();
	}
	else
	{
		document.querySelector('.read-along-job')?.remove();
	}
}

// --- Progress card ----------------------------------------------------------

function showProgress(): void
{
	document.querySelector('.read-along-job')?.remove();

	const card = document.createElement('div');
	card.className = 'read-along-job';
	card.innerHTML = `
		<div class="read-along-job-header">
			<span class="material-icon">record_voice_over</span>
			<span class="read-along-job-title"></span>
			<span class="material-icon read-along-job-cancel" title="Stop" onclick="reading.readAlongOcr.cancel();">close</span>
		</div>
		<div class="read-along-job-status"></div>
		<div class="read-along-job-bar"><div></div></div>
	`;

	card.querySelector('.read-along-job-title')!.textContent = `Making read-along · ${job!.title}`;
	(document.querySelector('.app') ?? document.body).appendChild(card);
	updateProgress();
}

function setStatus(status: string): void
{
	if(!job) return;

	job.status = status;
	updateProgress();
}

function updateProgress(): void
{
	const card = document.querySelector('.read-along-job');
	if(!card || !job) return;

	const fraction = job.total ? job.done / job.total : 0;
	let status = job.status;

	if(!status && job.total)
	{
		status = `Page ${job.done} of ${job.total}`;

		if(job.done >= 3 && job.done < job.total)
		{
			const minutes = Math.ceil((Date.now() - job.started) / job.done * (job.total - job.done) / 60000);
			status += ` · about ${minutes} min left`;
		}
	}

	card.querySelector('.read-along-job-status')!.textContent = status;
	(card.querySelector('.read-along-job-bar > div') as HTMLElement).style.width = `${Math.round(fraction * 100)}%`;
}

function finish(message: string, error = false): void
{
	const card = document.querySelector('.read-along-job');
	if(!card) return;

	card.classList.toggle('error', error);
	card.querySelector('.read-along-job-status')!.textContent = message;
	(card.querySelector('.read-along-job-bar > div') as HTMLElement).style.width = error ? '0%' : '100%';

	if(!error)
	{
		setTimeout(() => {

			if(!job) card.remove();

		}, 8000);
	}
}

export default {
	supported,
	hasPages,
	dialog,
	dialogFolder,
	dialogCurrent,
	confirm,
	cancel,
	get running() {return job !== null},
};
