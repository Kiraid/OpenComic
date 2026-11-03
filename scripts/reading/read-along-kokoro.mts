import p from 'path';
import url from 'url';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const appDir: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Natural voices for read-along: Kokoro-82M (Apache-2.0) running locally.
// vendor/kokoro-js/kokoro-worker.js does the work in a worker started from a
// hidden iframe (no Node integration there, so the browser backends load).
// The model downloads on first use and stays in the browser cache.

export interface Voice {
	id: string;
	name: string;
	accent: 'US' | 'UK';
	gender: 'female' | 'male';
	grade: string; // Kokoro's own quality grade for the voice (A best)
}

// Every English voice, best graded first in each group
export const VOICES: Voice[] = [
	{id: 'af_heart', name: 'Heart', accent: 'US', gender: 'female', grade: 'A'},
	{id: 'af_bella', name: 'Bella', accent: 'US', gender: 'female', grade: 'A-'},
	{id: 'af_nicole', name: 'Nicole', accent: 'US', gender: 'female', grade: 'B-'},
	{id: 'af_aoede', name: 'Aoede', accent: 'US', gender: 'female', grade: 'C+'},
	{id: 'af_kore', name: 'Kore', accent: 'US', gender: 'female', grade: 'C+'},
	{id: 'af_sarah', name: 'Sarah', accent: 'US', gender: 'female', grade: 'C+'},
	{id: 'af_alloy', name: 'Alloy', accent: 'US', gender: 'female', grade: 'C'},
	{id: 'af_nova', name: 'Nova', accent: 'US', gender: 'female', grade: 'C'},
	{id: 'af_sky', name: 'Sky', accent: 'US', gender: 'female', grade: 'C-'},
	{id: 'af_jessica', name: 'Jessica', accent: 'US', gender: 'female', grade: 'D'},
	{id: 'af_river', name: 'River', accent: 'US', gender: 'female', grade: 'D'},
	{id: 'am_fenrir', name: 'Fenrir', accent: 'US', gender: 'male', grade: 'C+'},
	{id: 'am_michael', name: 'Michael', accent: 'US', gender: 'male', grade: 'C+'},
	{id: 'am_puck', name: 'Puck', accent: 'US', gender: 'male', grade: 'C+'},
	{id: 'am_echo', name: 'Echo', accent: 'US', gender: 'male', grade: 'D'},
	{id: 'am_eric', name: 'Eric', accent: 'US', gender: 'male', grade: 'D'},
	{id: 'am_liam', name: 'Liam', accent: 'US', gender: 'male', grade: 'D'},
	{id: 'am_onyx', name: 'Onyx', accent: 'US', gender: 'male', grade: 'D'},
	{id: 'am_santa', name: 'Santa', accent: 'US', gender: 'male', grade: 'D-'},
	{id: 'am_adam', name: 'Adam', accent: 'US', gender: 'male', grade: 'F+'},
	{id: 'bf_emma', name: 'Emma', accent: 'UK', gender: 'female', grade: 'B-'},
	{id: 'bf_isabella', name: 'Isabella', accent: 'UK', gender: 'female', grade: 'C'},
	{id: 'bf_alice', name: 'Alice', accent: 'UK', gender: 'female', grade: 'D'},
	{id: 'bf_lily', name: 'Lily', accent: 'UK', gender: 'female', grade: 'D'},
	{id: 'bm_fable', name: 'Fable', accent: 'UK', gender: 'male', grade: 'C'},
	{id: 'bm_george', name: 'George', accent: 'UK', gender: 'male', grade: 'C'},
	{id: 'bm_lewis', name: 'Lewis', accent: 'UK', gender: 'male', grade: 'D+'},
	{id: 'bm_daniel', name: 'Daniel', accent: 'UK', gender: 'male', grade: 'D'},
];

// Shown in the reader until voices are picked in Settings
export const DEFAULT_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable'];

export interface Sound {
	audio: Float32Array;
	rate: number;
}

type State = 'idle' | 'loading' | 'ready' | 'error';

let state: State = 'idle';
let loaded = 0;
let total = 0;
let device = '';
let error = '';

let worker: Worker | null = null;
let loading: Promise<void> | null = null;
let loadDone: {resolve: () => void; reject: (error: Error) => void} | null = null;

let nextId = 0;
const pending = new Map<number, {resolve: (sound: Sound) => void; reject: (error: Error) => void}>();
const cache = new Map<string, Promise<Sound>>();
const CACHE_SIZE = 40;

const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | false = false;

function onChange(callback: () => void): void
{
	listeners.add(callback);
}

function offChange(callback: () => void): void
{
	listeners.delete(callback);
}

// Download progress fires often: tell listeners at most every 300 ms
function notify(now = false): void
{
	if(now)
	{
		if(notifyTimer) clearTimeout(notifyTimer);
		notifyTimer = false;
		listeners.forEach(callback => callback());
		return;
	}

	if(notifyTimer) return;

	notifyTimer = setTimeout(() => {

		notifyTimer = false;
		listeners.forEach(callback => callback());

	}, 300);
}

function onMessage(event: MessageEvent): void
{
	const message = event.data;

	switch(message.type)
	{
		case 'progress':

			loaded = message.loaded;
			total = message.total;
			notify();
			break;

		case 'ready':

			device = message.device;
			loadDone?.resolve();
			break;

		case 'audio':

			pending.get(message.id)?.resolve({audio: message.audio, rate: message.rate});
			pending.delete(message.id);
			break;

		case 'error':

			if(message.id === undefined)
				loadDone?.reject(new Error(message.message));
			else
				pending.get(message.id)?.reject(new Error(message.message));

			pending.delete(message.id);
			break;
	}
}

async function hasGpu(): Promise<boolean>
{
	const gpu = (navigator as Navigator & {gpu?: {requestAdapter(): Promise<unknown>}}).gpu;

	try
	{
		return !!(gpu && await gpu.requestAdapter());
	}
	catch
	{
		return false;
	}
}

function load(): Promise<void>
{
	if(loading) return loading;

	state = 'loading';
	loaded = total = 0;
	error = '';
	notify(true);

	loading = (async() => {

		const frame = document.createElement('iframe');
		frame.className = 'read-along-kokoro-frame';
		frame.style.display = 'none';

		const frameReady = new Promise<void>((resolve) => {

			const listener = (event: MessageEvent) => {

				if(event.source !== frame.contentWindow || !event.data?.kokoroFrameReady) return;

				window.removeEventListener('message', listener);
				resolve();

			};

			window.addEventListener('message', listener);

		});

		frame.src = url.pathToFileURL(p.join(appDir, 'vendor/kokoro-js/kokoro-frame.html')).href;
		document.body.appendChild(frame);
		await frameReady;

		// The frame's Worker constructor starts a worker without Node integration
		const realm = frame.contentWindow as Window & typeof globalThis;
		worker = new realm.Worker(new realm.URL('kokoro-worker.js', realm.location.href), {type: 'module'});
		worker.onmessage = onMessage;

		const gpu = await hasGpu();

		await new Promise<void>((resolve, reject) => {

			loadDone = {resolve, reject};
			worker!.postMessage({type: 'load', device: gpu ? 'webgpu' : 'wasm'});

		});

		state = 'ready';
		notify(true);

	})().catch((reason) => {

		state = 'error';
		error = String(reason?.message || reason);
		loading = null;
		worker?.terminate();
		worker = null;
		document.querySelectorAll('.read-along-kokoro-frame').forEach(frame => frame.remove());
		notify(true);
		throw reason;

	});

	return loading;
}

function synth(text: string, voice: string, speed: number): Promise<Sound>
{
	const key = `${voice}|${speed}|${text}`;
	const cached = cache.get(key);
	if(cached) return cached;

	const sound = load().then(() => new Promise<Sound>((resolve, reject) => {

		const id = nextId++;
		pending.set(id, {resolve, reject});
		worker!.postMessage({type: 'generate', id, text, voice, speed});

	}));

	sound.catch(() => cache.delete(key));
	cache.set(key, sound);

	// Drop the oldest
	while(cache.size > CACHE_SIZE)
		cache.delete(cache.keys().next().value!);

	return sound;
}

let context: AudioContext | null = null;

// Returns a function that stops playback (without calling onEnd)
function play(sound: Sound, volume: number, onEnd: () => void): () => void
{
	context ??= new AudioContext();

	const buffer = context.createBuffer(1, sound.audio.length, sound.rate);
	buffer.copyToChannel(sound.audio as Float32Array<ArrayBuffer>, 0);

	const source = context.createBufferSource();
	source.buffer = buffer;

	const gain = context.createGain();
	gain.gain.value = volume;
	source.connect(gain).connect(context.destination);

	let stopped = false;

	source.onended = function() {

		if(!stopped) onEnd();

	};

	source.start();

	return function() {

		stopped = true;

		try
		{
			source.stop();
		}
		catch
		{
			// Already finished
		}

	};
}

export default {
	VOICES,
	DEFAULT_VOICES,
	load,
	synth,
	play,
	onChange,
	offChange,
	get state() {return state},
	get device() {return device},
	get error() {return error},
	get progress() {return total ? loaded / total : 0},
	get downloadedMB() {return Math.round(loaded / 1048576)},
	get totalMB() {return Math.round(total / 1048576)},
};
