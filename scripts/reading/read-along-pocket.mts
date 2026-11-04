import p from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import net from 'net';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import childProcess, {ChildProcess} from 'child_process';
import {createRequire} from 'module';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const electronRemote: any;
declare const asarToAsarUnpacked: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Natural voices from Kyutai's Pocket TTS (code MIT, model weights CC BY 4.0).
// The official standalone build (Rust, CPU only, no Python) downloads on first
// use; `pocket-tts serve` then keeps the model loaded and makes each bubble's
// audio over HTTP on localhost. Custom voices are cloned from a clip with
// `pocket-tts export-voice`, which needs a Hugging Face key with access to
// kyutai/pocket-tts; the voice files it writes work without the key after that.

const RELEASE = 'https://github.com/kyutai-labs/pocket-tts/releases/download/v4.0.1/';

const BUILDS: Record<string, {file: string; sha256: string}> = {
	'win32-x64': {file: 'pocket-tts-3.3.0-x86_64-pc-windows-msvc.zip', sha256: '98753041f2e65744b989776f87bccb93f1f574a08afe1890c5427ec94cd6309c'},
	'linux-x64': {file: 'pocket-tts-3.3.0-x86_64-unknown-linux-gnu.tar.gz', sha256: '9abff0aa138a804e44052952d8c3bdaae247fb267ca8f4b83fe178897d1a0559'},
	'linux-arm64': {file: 'pocket-tts-3.3.0-aarch64-unknown-linux-gnu.tar.gz', sha256: '2b9a727bffd86ea6d73370d675cbd91a7db118f11b7f5a60343c2d5da12b187a'},
	'darwin-x64': {file: 'pocket-tts-3.3.0-x86_64-apple-darwin.tar.gz', sha256: 'f04baa94d4fc47a689cc9f11ca2b0ba869dc002f9e78e15d387c6ecaeb1d654b'},
	'darwin-arm64': {file: 'pocket-tts-3.3.0-aarch64-apple-darwin.tar.gz', sha256: 'ee9ca6c7c000ee72c5846e3a8ba01d08f56636d94a614d2259c3f12b8fd69afa'},
};

const BUILD = BUILDS[`${process.platform}-${process.arch}`];
const EXE = process.platform === 'win32' ? 'pocket-tts.exe' : 'pocket-tts';

// Asks Hugging Face whether a key may download the cloning weights
const GATED_FILE = 'https://huggingface.co/kyutai/pocket-tts/resolve/main/languages/english/tokenizer.json';
export const TERMS_URL = 'https://huggingface.co/kyutai/pocket-tts';
export const TOKENS_URL = 'https://huggingface.co/settings/tokens';

export interface Voice {
	id: string;
	name: string;
	gender: 'female' | 'male';
	accent?: string; // Recorded from a speaker of another language
}

// The built-in voices, the same in every English model
export const VOICES: Voice[] = [
	{id: 'alba', name: 'Alba', gender: 'female'},
	{id: 'anna', name: 'Anna', gender: 'female'},
	{id: 'azelma', name: 'Azelma', gender: 'female'},
	{id: 'bill_boerst', name: 'Bill Boerst', gender: 'male'},
	{id: 'caro_davy', name: 'Caro Davy', gender: 'female'},
	{id: 'charles', name: 'Charles', gender: 'male'},
	{id: 'cosette', name: 'Cosette', gender: 'female'},
	{id: 'eponine', name: 'Eponine', gender: 'female'},
	{id: 'eve', name: 'Eve', gender: 'female'},
	{id: 'fantine', name: 'Fantine', gender: 'female'},
	{id: 'george', name: 'George', gender: 'male'},
	{id: 'jane', name: 'Jane', gender: 'female'},
	{id: 'javert', name: 'Javert', gender: 'male'},
	{id: 'jean', name: 'Jean', gender: 'male'},
	{id: 'marius', name: 'Marius', gender: 'male'},
	{id: 'mary', name: 'Mary', gender: 'female'},
	{id: 'michael', name: 'Michael', gender: 'male'},
	{id: 'paul', name: 'Paul', gender: 'male'},
	{id: 'peter_yearsley', name: 'Peter Yearsley', gender: 'male'},
	{id: 'stuart_bell', name: 'Stuart Bell', gender: 'male'},
	{id: 'vera', name: 'Vera', gender: 'female'},
	{id: 'daan', name: 'Daan', gender: 'male', accent: 'Dutch'},
	{id: 'estelle', name: 'Estelle', gender: 'female', accent: 'French'},
	{id: 'giovanni', name: 'Giovanni', gender: 'male', accent: 'Italian'},
	{id: 'juergen', name: 'Juergen', gender: 'male', accent: 'German'},
	{id: 'lola', name: 'Lola', gender: 'female', accent: 'Spanish'},
	{id: 'rafael', name: 'Rafael', gender: 'male', accent: 'Portuguese'},
];

export const DEFAULT_VOICES = ['alba', 'marius', 'jean'];

export interface Model {
	id: string;
	name: string;
	size: number; // MB to download
}

export const MODELS: Model[] = [
	{id: 'english', name: 'Best (100M)', size: 215},
	{id: 'english_18m_refl_2026-10', name: 'Fast (18M)', size: 108},
	{id: 'english_7m_refl_2026-10', name: 'Faster (7M)', size: 65},
	{id: 'english_2m_refl_2026-10', name: 'Fastest (2M)', size: 46},
];

export interface CustomVoice {
	id: string;
	name: string;
	clip: string; // The original clip, kept to remake the voice for another model
	created: number;
}

interface Settings {
	model: string;
	token: string; // 'enc:' + base64 when the OS keychain could encrypt it, '' = none
	user: string; // Hugging Face user the key belongs to
	access: boolean; // The key can download the cloning weights (terms accepted)
	custom: CustomVoice[];
}

export interface Sound {
	wav: ArrayBuffer;
	seconds: number;
}

type Phase = 'idle' | 'installing' | 'starting' | 'ready' | 'error';
export type State = 'unsupported' | 'missing' | 'stopped' | 'installing' | 'starting' | 'ready' | 'error';

const IDLE_STOP = 10 * 60 * 1000; // Free the model's memory after 10 minutes unused
const CACHE_SIZE = 40;
const MB = 1024 * 1024;

let phase: Phase = 'idle';
let progress = '';
let error = '';
let cloning = ''; // Progress of a voice being made

let server: ChildProcess | null = null;
let port = 0;
let voiceServer: Promise<number> | null = null; // Serves custom voice files to the server
let installing: Promise<void> | null = null;
let starting: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | false = false;
let queue: Promise<unknown> = Promise.resolve(); // One line at a time
let pendingLines = 0;
const cache = new Map<string, Promise<Sound>>();

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

// Progress changes often: tell listeners at most every 300 ms
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

function message(reason: unknown): string
{
	return String((reason as Error)?.message || reason);
}

// --- Folders and settings -----------------------------------------------------

function dir(): string
{
	return p.join(electronRemote.app.getPath('userData'), 'read-along', 'pocket');
}

const binDir = () => p.join(dir(), 'bin');
const hfDir = () => p.join(dir(), 'hf'); // HF_HOME: the models, apart from any other Hugging Face cache
const voicesDir = () => p.join(dir(), 'voices');
const pidFile = () => p.join(dir(), 'server.pid');

let settingsCache: Settings | null = null;

function settings(): Settings
{
	if(settingsCache) return settingsCache;

	const defaults: Settings = {model: 'english', token: '', user: '', access: false, custom: []};

	try
	{
		settingsCache = {...defaults, ...JSON.parse(fs.readFileSync(p.join(dir(), 'settings.json'), 'utf8'))};
	}
	catch
	{
		settingsCache = defaults;
	}

	if(!MODELS.some(model => model.id === settingsCache!.model))
		settingsCache!.model = 'english';

	return settingsCache!;
}

function saveSettings(): void
{
	fs.mkdirSync(dir(), {recursive: true});
	const file = p.join(dir(), 'settings.json');
	fs.writeFileSync(file + '.tmp', JSON.stringify(settings(), null, '\t'));
	fs.renameSync(file + '.tmp', file);
}

// Keys are kept encrypted by the OS (DPAPI, Keychain, libsecret) when it can
function seal(token: string): string
{
	try
	{
		const safe = electronRemote.safeStorage;
		if(token && safe?.isEncryptionAvailable())
			return 'enc:' + Buffer.from(safe.encryptString(token)).toString('base64');
	}
	catch
	{
		// No keychain: keep it as is
	}

	return token;
}

function token(): string
{
	const stored = settings().token;
	if(!stored.startsWith('enc:')) return stored;

	try
	{
		return electronRemote.safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
	}
	catch
	{
		return '';
	}
}

// --- Install ------------------------------------------------------------------

function findExe(): string | false
{
	const search = (folder: string, depth: number): string | false => {

		if(!fs.existsSync(folder)) return false;

		for(const entry of fs.readdirSync(folder, {withFileTypes: true}))
		{
			const path = p.join(folder, entry.name);
			if(entry.isFile() && entry.name === EXE) return path;
			if(entry.isDirectory() && depth > 0)
			{
				const found = search(path, depth - 1);
				if(found) return found;
			}
		}

		return false;

	};

	return search(binDir(), 2);
}

function installed(): boolean
{
	return findExe() !== false;
}

// GitHub's release downloads don't allow browser requests (no CORS), so Node's https
function download(url: string, onProgress: (loaded: number, total: number) => void, redirects = 5): Promise<Buffer>
{
	return new Promise((resolve, reject) => {

		https.get(url, {headers: {'User-Agent': 'OpenComic'}}, (response) => {

			const status = response.statusCode || 0;

			if(status >= 300 && status < 400 && response.headers.location && redirects > 0)
			{
				response.resume();
				download(new URL(response.headers.location, url).href, onProgress, redirects - 1).then(resolve, reject);
				return;
			}

			if(status !== 200)
			{
				response.resume();
				reject(new Error(`Couldn't download Pocket TTS (HTTP ${status})`));
				return;
			}

			const total = +(response.headers['content-length'] || 0);
			const chunks: Buffer[] = [];
			let loaded = 0;

			response.on('data', (chunk: Buffer) => {

				chunks.push(chunk);
				loaded += chunk.length;
				onProgress(loaded, total);

			});

			response.on('end', () => resolve(Buffer.concat(chunks)));
			response.on('error', reject);

		}).on('error', () => reject(new Error('Couldn\'t reach GitHub to download Pocket TTS. Check the connection and try again.')));

	});
}

function run(command: string, args: string[], options: childProcess.SpawnOptions = {}): Promise<string>
{
	return new Promise((resolve, reject) => {

		const child = childProcess.spawn(command, args, {windowsHide: true, ...options});
		let log = '';

		child.stdout?.on('data', data => log += data);
		child.stderr?.on('data', data => log += data);
		child.on('error', reject);
		child.on('exit', code => code === 0 ? resolve(log) : reject(new Error(lastError(log) || `${p.basename(command)} failed (exit code ${code})`)));

	});
}

async function extract(archive: string, to: string): Promise<void>
{
	if(archive.endsWith('.zip'))
	{
		// The 7-Zip OpenComic ships for comic archives
		const require = createRequire(import.meta.url);
		const bin7z = asarToAsarUnpacked(require('7zip-bin-full').path7z);
		await run(bin7z, ['x', archive, '-o' + to, '-y']);
	}
	else
	{
		await run('tar', ['-xzf', archive, '-C', to]);
	}
}

function install(): Promise<void>
{
	if(installed()) return Promise.resolve();
	if(installing) return installing;
	if(!BUILD) return Promise.reject(new Error('Pocket TTS has no build for this system'));

	phase = 'installing';
	progress = 'Downloading the program…';
	error = '';
	notify(true);

	installing = (async() => {

		const data = await download(RELEASE + BUILD.file, (loaded, total) => {

			progress = `Downloading the program… ${Math.round(loaded / MB)} of ${Math.round(total / MB)} MB`;
			notify();

		});

		if(crypto.createHash('sha256').update(data).digest('hex') !== BUILD.sha256)
			throw new Error('Pocket TTS didn\'t download correctly (checksum mismatch). Try again.');

		progress = 'Unpacking…';
		notify(true);

		await fsp.mkdir(dir(), {recursive: true});
		const archive = p.join(dir(), BUILD.file);
		const temp = p.join(dir(), 'bin.tmp');

		await fsp.writeFile(archive, data);
		await fsp.rm(temp, {recursive: true, force: true});
		await fsp.mkdir(temp, {recursive: true});
		await extract(archive, temp);
		await fsp.rm(archive, {force: true});
		await fsp.rm(binDir(), {recursive: true, force: true});
		await fsp.rename(temp, binDir());

		const exe = findExe();
		if(!exe) throw new Error('The Pocket TTS download didn\'t contain the program');
		if(process.platform !== 'win32') await fsp.chmod(exe, 0o755);

		phase = 'idle';
		progress = '';

	})().catch((reason) => {

		phase = 'error';
		error = message(reason);
		throw reason;

	}).finally(() => {

		installing = null;
		notify(true);

	});

	return installing;
}

// Deletes the program and the models; custom voices stay
async function remove(): Promise<void>
{
	stop();
	await installing?.catch(() => {});
	await starting?.catch(() => {});
	await fsp.rm(binDir(), {recursive: true, force: true});
	await fsp.rm(hfDir(), {recursive: true, force: true});

	// Voices made for a model are remade from their clips when needed
	for(const file of fs.existsSync(voicesDir()) ? fs.readdirSync(voicesDir()) : [])
	{
		if(file.endsWith('.safetensors'))
			await fsp.rm(p.join(voicesDir(), file), {force: true});
	}

	cache.clear();
	phase = 'idle';
	error = '';
	notify(true);
}

// --- Server -------------------------------------------------------------------

// The last error line of the program's log, without its log prefix and colours
function lastError(log: string): string
{
	// eslint-disable-next-line no-control-regex
	const lines = log.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	const errorLine = [...lines].reverse().find(line => /^(ERROR|Error)\b/.test(line));
	return (errorLine || '').replace(/^(ERROR:?|Error:)\s*/, '');
}

function freePort(): Promise<number>
{
	return new Promise((resolve, reject) => {

		const probe = net.createServer();
		probe.unref();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {

			const address = probe.address();
			probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));

		});

	});
}

async function dirSize(folder: string): Promise<number>
{
	let size = 0;

	try
	{
		for(const entry of await fsp.readdir(folder, {withFileTypes: true}))
		{
			const path = p.join(folder, entry.name);
			if(entry.isDirectory()) size += await dirSize(path);
			else if(entry.isFile()) size += (await fsp.stat(path).catch(() => ({size: 0}))).size;
		}
	}
	catch
	{
		// Not there yet
	}

	return size;
}

// A server left behind by a crash would hold its memory: stop it, if it really is ours
function stopLeftover(): void
{
	let pid: number;

	try
	{
		pid = +fs.readFileSync(pidFile(), 'utf8');
	}
	catch
	{
		return;
	}

	try
	{
		const name = process.platform === 'win32' ? childProcess.execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {windowsHide: true, timeout: 5000}).toString() : childProcess.execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {timeout: 5000}).toString();

		if(name.includes('pocket-tts'))
			process.kill(pid);
	}
	catch
	{
		// Already gone
	}

	fs.rmSync(pidFile(), {force: true});
}

function serverEnv(): NodeJS.ProcessEnv
{
	const env: NodeJS.ProcessEnv = {...process.env, HF_HOME: hfDir(), HF_HUB_DISABLE_TELEMETRY: '1'};

	// Without a key the server loads the weights every voice can use; with one it
	// would download the cloning weights too, which only making a voice needs
	delete env.HF_TOKEN;
	delete env.HUGGING_FACE_HUB_TOKEN;

	return env;
}

// Node's http: the server sends no CORS headers, so the page's fetch can't read it
function local(path: string, body?: {data: Buffer; type: string}, timeout = 0): Promise<{status: number; data: Buffer}>
{
	return new Promise((resolve, reject) => {

		const request = http.request({host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', timeout, headers: body ? {'Content-Type': body.type, 'Content-Length': body.data.length} : {}}, (response) => {

			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({status: response.statusCode || 0, data: Buffer.concat(chunks)}));
			response.on('error', reject);

		});

		request.on('timeout', () => request.destroy(new Error('Timed out')));
		request.on('error', reject);
		request.end(body?.data);

	});
}

function multipart(fields: Record<string, string>): {data: Buffer; type: string}
{
	const boundary = '----OpenComic' + crypto.randomBytes(12).toString('hex');
	const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
	return {data: Buffer.from(parts.join('') + `--${boundary}--\r\n`), type: `multipart/form-data; boundary=${boundary}`};
}

async function waitForServer(child: ChildProcess, model: Model, failed: () => string): Promise<void>
{
	const before = await dirSize(hfDir());
	const deadline = Date.now() + 30 * 60 * 1000;

	while(server === child)
	{
		try
		{
			if((await local('/', undefined, 2000)).status === 200) return;
		}
		catch
		{
			// Not listening yet
		}

		if(child.exitCode !== null) break;
		if(Date.now() > deadline) throw new Error('Pocket TTS took too long to start');

		const downloaded = Math.round((await dirSize(hfDir()) - before) / MB);
		progress = downloaded > 1 ? `Downloading the ${model.name} model…${Math.min(downloaded, model.size)} of about ${model.size} MB` : 'Loading the model…';
		notify();

		await new Promise(resolve => setTimeout(resolve, 700));
	}

	throw new Error(failed() || 'Pocket TTS stopped while starting');
}

function start(): Promise<void>
{
	if(phase === 'ready' && server) return Promise.resolve();
	if(starting) return starting;

	starting = (async() => {

		await install();

		phase = 'starting';
		progress = 'Starting…';
		error = '';
		notify(true);

		stopLeftover();
		port = await freePort();

		const model = MODELS.find(model => model.id === settings().model)!;
		const child = childProcess.spawn(findExe() as string, ['serve', '--host', '127.0.0.1', '--port', String(port), '--language', model.id], {env: serverEnv(), windowsHide: true});
		let log = '';

		server = child;
		fs.writeFileSync(pidFile(), String(child.pid));

		const keepLog = (data: Buffer) => log = (log + data).slice(-8000);
		child.stdout?.on('data', keepLog);
		child.stderr?.on('data', keepLog);

		child.on('error', reason => log += `\nERROR: ${reason.message}`);
		child.on('exit', () => {

			if(server !== child) return;

			server = null;
			fs.rmSync(pidFile(), {force: true});

			// It stopped by itself: start again on the next line
			if(phase === 'ready')
			{
				phase = 'idle';
				notify(true);
			}

		});

		await waitForServer(child, model, () => lastError(log));

		phase = 'ready';
		progress = '';
		keepAlive();

	})().catch((reason) => {

		stop();
		phase = 'error';
		error = message(reason);
		throw reason;

	}).finally(() => {

		starting = null;
		notify(true);

	});

	return starting;
}

function stop(): void
{
	if(idleTimer) clearTimeout(idleTimer);
	idleTimer = false;

	if(server)
	{
		const child = server;
		server = null;
		child.kill();
		fs.rmSync(pidFile(), {force: true});
	}

	if(phase === 'ready' || phase === 'starting')
	{
		phase = 'idle';
		notify(true);
	}
}

function keepAlive(): void
{
	if(idleTimer) clearTimeout(idleTimer);

	idleTimer = setTimeout(() => {

		if(pendingLines === 0) stop();

	}, IDLE_STOP);
}

window.addEventListener('beforeunload', stop);

// --- Speech -------------------------------------------------------------------

function enqueue<T>(task: () => Promise<T>): Promise<T>
{
	pendingLines++;
	const result = queue.then(task, task).finally(() => pendingLines--);
	queue = result.catch(() => {});
	return result;
}

async function request(text: string, voice: string): Promise<Sound>
{
	keepAlive();
	let response: {status: number; data: Buffer};

	try
	{
		response = await local('/tts', multipart({text, voice_url: voice}));
	}
	catch
	{
		stop(); // Start again on the next line
		throw new Error('Pocket TTS isn\'t answering');
	}

	if(response.status !== 200)
	{
		const detail = response.data.toString('utf8').slice(0, 200);
		throw new Error(`Pocket TTS couldn't read this line (${response.status}${detail ? ': ' + detail : ''})`);
	}

	const wav = response.data;
	if(wav.length <= 44) throw new Error('Pocket TTS returned no audio');

	// The streamed header has no sizes: fill them in so the player knows the length
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.writeUInt32LE(wav.length - 44, 40);

	keepAlive();

	const rate = wav.readUInt32LE(24) || 24000;
	return {wav: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length) as ArrayBuffer, seconds: (wav.length - 44) / (rate * 2)};
}

// The voice the server is given: a built-in name, or a URL to the file a custom voice was saved to
async function voiceSource(voice: string): Promise<string>
{
	if(!voice.startsWith('custom:')) return voice;

	const custom = settings().custom.find(custom => custom.id === voice.slice(7));
	if(!custom) throw new Error('This custom voice was deleted');

	const file = voiceFile(custom.id);

	// Made for another model: remake it from its clip
	if(!fs.existsSync(file))
		await exportVoice(p.join(voicesDir(), custom.clip), file, `Adapting ${custom.name} to this model…`);

	return voiceUrl(file);
}

// The server takes voices only by URL (http, https or hf), and a voice file is
// too big to upload with each line, so custom voices are served from localhost
function voiceUrl(file: string): Promise<string>
{
	if(!voiceServer)
	{
		voiceServer = new Promise((resolve, reject) => {

			const listener = http.createServer(async(request, response) => {

				const name = decodeURIComponent((request.url || '').slice(1));

				try
				{
					if(!/^[\w.-]+\.safetensors$/.test(name)) throw new Error('Not a voice');
					const path = p.join(voicesDir(), name);
					const stats = await fsp.stat(path);
					response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': stats.size});
					fs.createReadStream(path).pipe(response);
				}
				catch
				{
					response.writeHead(404).end();
				}

			});

			listener.on('error', reject);
			listener.listen(0, '127.0.0.1', () => resolve((listener.address() as net.AddressInfo).port));

		});

		voiceServer.catch(() => voiceServer = null);
	}

	return voiceServer.then(voicePort => `http://127.0.0.1:${voicePort}/${encodeURIComponent(p.basename(file))}`);
}

function voiceFile(id: string): string
{
	return p.join(voicesDir(), `${id}.${settings().model}.safetensors`);
}

function synth(text: string, voice: string): Promise<Sound>
{
	const key = `${settings().model}|${voice}|${text}`;
	const cached = cache.get(key);
	if(cached) return cached;

	const sound = (async() => {

		const source = await voiceSource(voice);
		await start();
		return enqueue(async() => {

			if(!server) await start(); // Stopped while this line waited
			return request(text, source);

		});

	})();

	sound.catch(() => cache.delete(key));
	cache.set(key, sound);

	while(cache.size > CACHE_SIZE)
		cache.delete(cache.keys().next().value!);

	return sound;
}

// Speed changes the tempo, not the pitch. Returns a function that stops playback (without onEnd)
function play(sound: Sound, volume: number, speed: number, onEnd: () => void): () => void
{
	const url = URL.createObjectURL(new Blob([sound.wav], {type: 'audio/wav'}));
	const audio = new Audio(url);
	audio.preservesPitch = true;
	audio.playbackRate = speed;
	audio.volume = Math.max(0, Math.min(1, volume));

	let finished = false;

	const finish = (callEnd: boolean) => {

		if(finished) return;
		finished = true;
		URL.revokeObjectURL(url);
		if(callEnd) onEnd();

	};

	audio.onended = () => finish(true);
	audio.onerror = () => finish(true);
	audio.play().catch(() => finish(true));

	return function() {

		audio.pause();
		finish(false);

	};
}

// --- Custom voices ------------------------------------------------------------

export const CLIP_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'];

function exportVoice(clip: string, out: string, status: string): Promise<void>
{
	return enqueue(async() => {

		await install();

		const key = token();
		if(!key) throw new Error('Making a custom voice for this model needs your Hugging Face key (Settings → Read-along)');
		if(!fs.existsSync(clip)) throw new Error('The clip this voice was made from is missing');

		const model = MODELS.find(model => model.id === settings().model)!;
		const child = childProcess.spawn(findExe() as string, ['export-voice', '--language', model.id, clip, out], {env: {...serverEnv(), HF_TOKEN: key}, windowsHide: true});
		let log = '';
		let done = false;

		const keepLog = (data: Buffer) => log = (log + data).slice(-8000);
		child.stdout?.on('data', keepLog);
		child.stderr?.on('data', keepLog);

		const exit = new Promise<number>((resolve) => {

			child.on('error', (reason) => {

				log += `\nERROR: ${reason.message}`;
				resolve(-1);

			});
			child.on('exit', code => resolve(code ?? -1));

		});

		// The first voice downloads the cloning weights: show how far along that is
		const before = await dirSize(hfDir());

		const watch = (async() => {

			while(!done)
			{
				const downloaded = Math.round((await dirSize(hfDir()) - before) / MB);
				cloning = downloaded > 1 ? `Downloading the cloning model… ${Math.min(downloaded, model.size)} of about ${model.size} MB` : status;
				notify();
				await new Promise(resolve => setTimeout(resolve, 700));
			}

		})();

		const code = await exit;
		done = true;
		await watch;
		cloning = '';
		notify(true);

		if(code === 0 && fs.existsSync(out)) return;

		await fsp.rm(out, {force: true});

		if(/could not download the weights for the model with voice cloning/i.test(log))
		{
			settings().access = false;
			saveSettings();
			throw new Error(`Hugging Face didn't let your key download the cloning model. Accept the terms at ${TERMS_URL} and try again.`);
		}

		throw new Error(lastError(log) || `Pocket TTS couldn't make the voice (exit code ${code})`);

	});
}

async function addVoice(clipPath: string, name: string): Promise<CustomVoice>
{
	name = name.trim();
	const extension = p.extname(clipPath).slice(1).toLowerCase();

	if(!name) throw new Error('Give the voice a name');
	if(settings().custom.some(custom => custom.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already a voice called ${name}`);
	if(!CLIP_EXTENSIONS.includes(extension)) throw new Error(`Pocket TTS can't read .${extension} files. Use ${CLIP_EXTENSIONS.join(', ')}.`);
	if(!token()) throw new Error('Add your Hugging Face key first');

	const stats = await fsp.stat(clipPath).catch(() => null);
	if(!stats?.isFile()) throw new Error('That file can\'t be opened');
	if(stats.size > 100 * MB) throw new Error('That file is too big: only its first 30 seconds are used, so cut a shorter clip');

	const id = crypto.randomBytes(6).toString('hex');
	const voice: CustomVoice = {id, name, clip: `${id}.${extension}`, created: Date.now()};

	await fsp.mkdir(voicesDir(), {recursive: true});
	const clip = p.join(voicesDir(), voice.clip);
	await fsp.copyFile(clipPath, clip);

	try
	{
		await exportVoice(clip, voiceFile(id), `Making ${name}…`);
	}
	catch (reason)
	{
		await fsp.rm(clip, {force: true});
		throw reason;
	}

	settings().custom.push(voice);
	saveSettings();
	notify(true);

	return voice;
}

async function removeVoice(id: string): Promise<void>
{
	settings().custom = settings().custom.filter(custom => custom.id !== id);
	saveSettings();

	for(const file of fs.existsSync(voicesDir()) ? fs.readdirSync(voicesDir()) : [])
	{
		if(file.startsWith(id + '.'))
			await fsp.rm(p.join(voicesDir(), file), {force: true});
	}

	for(const key of [...cache.keys()])
	{
		if(key.includes(`|custom:${id}|`)) cache.delete(key);
	}

	notify(true);
}

function renameVoice(id: string, name: string): void
{
	name = name.trim();
	const custom = settings().custom.find(custom => custom.id === id);
	if(!custom || !name) return;

	custom.name = name;
	saveSettings();
	notify(true);
}

// --- Hugging Face key ---------------------------------------------------------

async function checkKey(key: string): Promise<{user: string; access: boolean}>
{
	const headers = {Authorization: `Bearer ${key}`};
	let response: Response;

	try
	{
		response = await fetch('https://huggingface.co/api/whoami-v2', {headers});
	}
	catch
	{
		throw new Error('Couldn\'t reach Hugging Face. Check the connection and try again.');
	}

	if(response.status === 401) throw new Error(`Hugging Face doesn't recognise this key. Copy it again from ${TOKENS_URL}.`);
	if(!response.ok) throw new Error(`Hugging Face answered with an error (${response.status}). Try again later.`);

	const user = String((await response.json().catch(() => ({})))?.name || '');

	// A HEAD of a small file in the gated repo: 200 once the terms are accepted
	const gated = await fetch(GATED_FILE, {method: 'HEAD', headers, redirect: 'manual'}).catch(() => null);
	const access = !!gated && (gated.ok || gated.type === 'opaqueredirect');

	return {user, access};
}

async function setKey(key: string): Promise<void>
{
	key = key.trim();
	if(!key) throw new Error('Paste your Hugging Face key');
	if(!/^hf_[A-Za-z0-9]{20,}$/.test(key)) throw new Error('That doesn\'t look like a Hugging Face key: they start with hf_');

	const {user, access} = await checkKey(key);
	const current = settings();
	current.token = seal(key);
	current.user = user;
	current.access = access;
	saveSettings();
	notify(true);
}

async function recheckKey(): Promise<void>
{
	const key = token();
	if(!key) return;

	const {user, access} = await checkKey(key);
	settings().user = user;
	settings().access = access;
	saveSettings();
	notify(true);
}

function clearKey(): void
{
	const current = settings();
	current.token = '';
	current.user = '';
	current.access = false;
	saveSettings();
	notify(true);
}

function setModel(id: string): void
{
	if(!MODELS.some(model => model.id === id) || settings().model === id) return;

	settings().model = id;
	saveSettings();
	stop(); // The next line starts the server with the new model
	notify(true);
}

export default {
	VOICES,
	MODELS,
	DEFAULT_VOICES,
	CLIP_EXTENSIONS,
	TERMS_URL,
	TOKENS_URL,
	install,
	remove,
	start,
	stop,
	synth,
	play,
	addVoice,
	removeVoice,
	renameVoice,
	setKey,
	recheckKey,
	clearKey,
	setModel,
	onChange,
	offChange,
	get state(): State
	{
		if(!BUILD) return 'unsupported';
		if(phase === 'idle') return installed() ? (server ? 'ready' : 'stopped') : 'missing';
		return phase;
	},
	get progress() {return progress},
	get error() {return error},
	get cloning() {return cloning},
	get model() {return settings().model},
	get custom() {return settings().custom},
	get hasKey() {return !!settings().token},
	get keyUser() {return settings().user},
	get keyAccess() {return settings().access},
	get downloadedMB() {return dirSize(dir()).then(size => Math.round(size / MB))},
};
