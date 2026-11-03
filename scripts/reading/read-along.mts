import p from 'path';
import fs from 'fs';

import kokoro, {Sound as KokoroSound} from './read-along-kokoro.mjs';
import pocket, {Sound as PocketSound} from './read-along-pocket.mjs';
import readAlongVoices, {CatalogVoice, Engine, systemVoices, systemVoiceLabel} from './read-along-voices.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const reading: any;
declare const template: any;
declare const language: any;
declare const onReading: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Sidecar written by tools/read-along/ocr_comic.py
interface Bubble {
	box: [number, number, number, number];
	area: [number, number, number, number] | null;
	text: string;
	sfx: boolean;
}

interface Page {
	width: number;
	height: number;
	bubbles: Bubble[];
}

interface Sidecar {
	version: number;
	rtl: boolean;
	pages: Record<string, Page>;
}

interface Item {
	page: number; // Reading index
	width: number;
	height: number;
	bubble: Bubble;
}

interface Options {
	enabled: boolean; // Read-along mode, toggled from the reader header
	speed: number;
	voice: boolean;
	engine: Engine;
	voiceName: string; // System voice, '' = the system's default
	kokoroVoice: string; // Kokoro voice id, e.g. 'af_heart'
	pocketVoice: string; // Pocket voice id, e.g. 'alba', or 'custom:<id>'
	volume: number;
	sfx: boolean;
}

interface HTMLElementBubble extends HTMLElement {
	_item?: number;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const WORDS_PER_MINUTE = 180;

let data: Sidecar | false = false;
let comicPath = ''; // The comic open in the reader, with or without a sidecar
let items: Item[] = [];
let current = -1;
let playing = false;
let timer: ReturnType<typeof setTimeout> | false = false;
let navigatingUntil = 0;
let speechId = 0;
let options: Options = {enabled: false, speed: 1, voice: true, engine: 'system', voiceName: '', kokoroVoice: 'af_heart', pocketVoice: 'alba', volume: 1, sfx: false};
let stopSound: (() => void) | false = false;

function loadOptions(): void
{
	try
	{
		options = {...options, ...JSON.parse(localStorage.getItem('readAlong') || '{}')};
	}
	catch
	{
		// Unreadable or unavailable storage: keep the defaults
	}
}

function saveOptions(): void
{
	try
	{
		localStorage.setItem('readAlong', JSON.stringify(options));
	}
	catch
	{
		// Unavailable storage: options last for this session only
	}
}

function sidecarPath(path: string): string | false
{
	for(const file of [path + '.readalong.json', p.join(path, 'readalong.json')])
	{
		if(fs.existsSync(file))
			return file;
	}

	return false;
}

// Whether the comic has a sidecar, so the header can show the read-along button
function has(path: string): boolean
{
	return sidecarPath(path) !== false;
}

function enabled(): boolean
{
	loadOptions();
	return options.enabled;
}

function load(path: string): void
{
	destroy();
	loadOptions();
	checkVoice();
	comicPath = path;

	const file = sidecarPath(path);
	if(!file) return;

	try
	{
		data = JSON.parse(fs.readFileSync(file, 'utf8')) as Sidecar;
	}
	catch (error)
	{
		console.error(error);
		return;
	}

	items = [];
	current = -1;

	if(options.enabled)
		addControls();
}

// Header button: show or hide the bar and the bubble highlights
function toggleMode(): void
{
	if(!data) return;

	options.enabled = !options.enabled;
	saveOptions();

	if(options.enabled)
	{
		addControls();
		current = firstOnPage(reading.currentIndex()) - 1;
		render();
	}
	else
	{
		pause();
		removeControls();
		document.querySelectorAll('oc-read-along').forEach(element => element.remove());
	}

	for(const button of document.querySelectorAll('.button-reading-read-along'))
	{
		button.classList.toggle('fill', options.enabled);
		button.setAttribute('hover-text', options.enabled ? language.reading.readAlong.turnOff : language.reading.readAlong.main);
	}
}

// Images are known only once reading has loaded, so the list is built on first use
function buildItems(): Item[]
{
	if(!data) return [];
	if(items.length) return items;

	const list: Item[] = [];

	for(const name in data.pages)
	{
		const image = reading.getImageByName(name);
		if(!image) continue;

		const page = data.pages[name];

		for(const bubble of page.bubbles)
		{
			if(bubble.sfx && !options.sfx) continue;
			list.push({page: image.index, width: page.width, height: page.height, bubble});
		}
	}

	// Pages in reading order; bubbles keep the sidecar's order within a page
	items = list.map((item, i) => ({item, i})).sort((a, b) => a.item.page - b.item.page || a.i - b.i).map(v => v.item);
	return items;
}

function firstOnPage(page: number): number
{
	const list = buildItems();
	const index = list.findIndex(item => item.page >= page);
	return index === -1 ? list.length - 1 : index;
}

function pagesAround(index: number): number[]
{
	return [index - 1, index, index + 1, index + 2];
}

function render(index: number = reading.currentIndex()): void
{
	if(!data || !onReading || !options.enabled) return;

	const list = buildItems();
	const contentRight = template._contentRight();

	for(const page of pagesAround(index))
	{
		const ocImg = contentRight.querySelector('.reading-body .r-img-i' + page + ' oc-img');
		if(!ocImg || ocImg.querySelector('oc-read-along')) continue;

		const fragment = document.createElement('template');

		list.forEach((item, i) => {

			if(item.page !== page) return;

			// Highlight the bubble's shape when found, else the text with some padding
			const [x1, y1, x2, y2] = item.bubble.area || pad(item.bubble.box, item);
			const element = document.createElement('oc-read-along') as HTMLElementBubble;
			element._item = i;
			element.style.cssText = `left: ${x1 / item.width * 100}%; top: ${y1 / item.height * 100}%; width: ${(x2 - x1) / item.width * 100}%; height: ${(y2 - y1) / item.height * 100}%;`;

			// Clicking a bubble plays from there
			element.addEventListener('click', function(event) {

				event.stopPropagation();
				playFrom(i);

			});

			fragment.content.appendChild(element);

		});

		ocImg.appendChild(fragment.content);
	}

	updateActive();
}

function pad(box: Bubble['box'], item: Item): Bubble['box']
{
	const padding = 0.01 * Math.max(item.width, item.height);
	return [box[0] - padding, box[1] - padding, box[2] + padding, box[3] + padding];
}

function updateActive(): HTMLElement | null
{
	let active: HTMLElement | null = null;

	for(const element of document.querySelectorAll('oc-read-along') as NodeListOf<HTMLElementBubble>)
	{
		const isActive = element._item === current;
		element.classList.toggle('active', isActive);

		if(isActive && element.closest('.reading-body'))
			active = element;
	}

	const play = document.querySelector('.read-along-play');
	if(play) play.setAttribute('title', `${playing ? 'Pause' : 'Play'} (R)` + (items.length && current >= 0 ? ` · bubble ${current + 1} of ${items.length}` : ''));

	return active;
}

function onScreen(element: Element | null): boolean
{
	if(!element) return false;

	const rect = element.getBoundingClientRect();
	return rect.bottom > 0 && rect.top < window.innerHeight;
}

// Reading moved to a page (user turned it, or we did)
function focusIndex(index: number): void
{
	if(!data || !options.enabled) return;

	render(index);

	// Our own page turn or scroll passing through pages: keep the cursor
	if(Date.now() < navigatingUntil || items[current]?.page === index)
		return;

	if(reading.viewIs('scroll') && onScreen(document.querySelector('.reading-body oc-read-along.active')))
		return;

	// The reader moved somewhere else: carry on from there
	const first = buildItems().findIndex(item => item.page === index);

	if(playing && first !== -1)
	{
		go(first, true);
		return;
	}

	if(playing)
		pause();

	current = firstOnPage(index) - 1;
	updateActive();
}

function go(index: number, speak = false): void
{
	const list = buildItems();
	if(!list.length) return;

	stopSpeaking();

	if(index < 0 || index >= list.length)
	{
		pause();
		return;
	}

	current = index;
	const item = list[current];
	navigatingUntil = Date.now() + 1500;

	render(item.page);
	const active = updateActive();

	// Scroll view: keep the bubble in the middle of the screen (the page
	// follows from the scroll); other views turn to the bubble's page
	if(active && reading.viewIs('scroll'))
		active.scrollIntoView({block: 'center', behavior: 'smooth'});
	else if(item.page !== reading.currentIndex())
		reading.goToIndex(item.page, true);

	if(speak)
		say(item);
}

function next(): void
{
	go(current + 1, playing);
}

function prev(): void
{
	go(Math.max(0, current - 1), playing);
}

// All-caps lettering reads better (and isn't spelled out) in sentence case
function speechText(text: string): string
{
	let speech = text.replace(/\.{2,}|…/g, '... ').replace(/--/g, ', ');

	if(speech === speech.toUpperCase())
	{
		speech = speech.toLowerCase()
			.replace(/(^|[.!?]\s+)([a-z])/g, (_m, a, b) => a + b.toUpperCase())
			.replace(/\bi\b/g, 'I');
	}

	return speech;
}

function chosenVoice(): SpeechSynthesisVoice | undefined
{
	return systemVoices().find(voice => voice.name === options.voiceName);
}

function utterance(text: string): SpeechSynthesisUtterance
{
	const speech = new SpeechSynthesisUtterance(text);
	const voice = chosenVoice();
	if(voice) speech.voice = voice;
	speech.rate = options.speed;
	speech.volume = options.volume;
	return speech;
}

function say(item: Item): void
{
	const id = speechId;

	const done = function() {

		// cancel() ends the interrupted utterance too: only the latest one advances
		if(playing && id === speechId)
			timer = setTimeout(next, 350 / options.speed);

	};

	const engine = natural();

	if(engine)
	{
		setWaiting(true);

		engine.synth(speechText(item.bubble.text)).then(function(sound) {

			if(id !== speechId) return; // Skipped or paused meanwhile

			setWaiting(false);
			stopSound = engine.play(sound, done);

		}).catch(function(error) {

			if(id !== speechId) return;

			// Keep reading along, just without the voice
			console.error(error);
			setWaiting(false);
			hold(item, done);

		});

		// Make the next bubbles while this one is spoken
		for(const ahead of items.slice(current + 1, current + 3))
			engine.synth(speechText(ahead.bubble.text)).catch(() => {});
	}
	else if(options.voice && systemVoices().length)
	{
		const speech = utterance(speechText(item.bubble.text));
		speech.onend = done;
		speech.onerror = done;
		speechSynthesis.speak(speech);
	}
	else
	{
		hold(item, done);
	}
}

// No voice: hold the bubble for as long as it takes to read it
function hold(item: Item, done: () => void): void
{
	const words = item.bubble.text.split(/\s+/).length;
	const seconds = Math.max(1.2, words / (WORDS_PER_MINUTE * options.speed) * 60);
	timer = setTimeout(done, seconds * 1000);
}

type Sound = KokoroSound | PocketSound;

// The chosen natural voice (Kokoro or Pocket TTS), or false for a system voice or none
function natural(): {synth: (text: string) => Promise<Sound>; play: (sound: Sound, onEnd: () => void) => () => void} | false
{
	if(!options.voice) return false;

	if(options.engine === 'kokoro')
	{
		const voice = options.kokoroVoice;
		const speed = options.speed;
		return {synth: text => kokoro.synth(text, voice, speed), play: (sound, onEnd) => kokoro.play(sound as KokoroSound, options.volume, onEnd)};
	}

	if(options.engine === 'pocket')
	{
		const voice = options.pocketVoice;
		return {synth: text => pocket.synth(text, voice), play: (sound, onEnd) => pocket.play(sound as PocketSound, options.volume, options.speed, onEnd)};
	}

	return false;
}

function stopSpeaking(): void
{
	speechId++;

	if(timer) clearTimeout(timer);
	timer = false;

	if(stopSound) stopSound();
	stopSound = false;
	setWaiting(false);

	if(typeof speechSynthesis !== 'undefined')
		speechSynthesis.cancel();
}

// A natural voice is still being made (or downloaded): pulse the play button
function setWaiting(waiting: boolean): void
{
	document.querySelector('.read-along-controls')?.classList.toggle('waiting', waiting);
}

function play(): void
{
	if(!buildItems().length) return;

	checkVoice();
	playing = true;
	updateControls();

	const start = current >= 0 && items[current]?.page === reading.currentIndex() ? current : firstOnPage(reading.currentIndex());
	go(start, true);
}

function playFrom(index: number): void
{
	checkVoice();
	playing = true;
	updateControls();
	go(index, true);
}

function pause(): void
{
	playing = false;
	stopSpeaking();
	updateControls();
}

function toggle(): void
{
	if(playing)
		pause();
	else
		play();
}

function addControls(): void
{
	removeControls();

	const bar = element('div', 'read-along-controls');
	bar.innerHTML = `
		<span class="material-icon read-along-button read-along-prev" title="Previous bubble (J)">skip_previous</span>
		<span class="material-icon read-along-button read-along-play">play_arrow</span>
		<span class="material-icon read-along-button read-along-next" title="Next bubble (K)">skip_next</span>
		<span class="material-icon read-along-button read-along-settings" title="Voice, speed and sound effects">tune</span>
		<div class="read-along-menu"></div>
	`;

	bar.addEventListener('click', function(event) {

		event.stopPropagation();
		const target = event.target as HTMLElement;
		const speed = target.closest('[data-speed]') as HTMLElement | null;
		const voice = target.closest('[data-voice]') as HTMLElement | null;
		const kokoroVoice = target.closest('[data-kokoro-voice]') as HTMLElement | null;
		const pocketVoice = target.closest('[data-pocket-voice]') as HTMLElement | null;

		if(target.closest('.read-along-prev')) prev();
		else if(target.closest('.read-along-play')) toggle();
		else if(target.closest('.read-along-next')) next();
		else if(target.closest('.read-along-settings')) bar.classList.toggle('menu-open');
		else if(speed)
		{
			options.speed = +speed.dataset.speed!;
			saveOptions();
		}
		else if(voice) chooseVoice(voice.dataset.voice!);
		else if(kokoroVoice) chooseNaturalVoice('kokoro', kokoroVoice.dataset.kokoroVoice!);
		else if(pocketVoice) chooseNaturalVoice('pocket', pocketVoice.dataset.pocketVoice!);
		else if(target.closest('.read-along-voice-off')) chooseVoice(false);
		else if(target.closest('.read-along-toggle'))
		{
			options.sfx = !options.sfx;
			saveOptions();
			rebuild();
		}

		updateControls();

	});

	bar.addEventListener('input', function(event) {

		const target = event.target as HTMLInputElement;

		if(target.classList.contains('read-along-volume'))
		{
			options.volume = +target.value;
			saveOptions();
		}

	});

	// Inside .app, where the theme's colour variables are defined
	(document.querySelector('.app') ?? document.body).appendChild(bar);
	document.addEventListener('keydown', keydown, true);
	document.addEventListener('click', closeMenuOutside, true);

	if(typeof speechSynthesis !== 'undefined')
		speechSynthesis.addEventListener('voiceschanged', updateControls);

	kokoro.onChange(updateControls);
	pocket.onChange(updateControls);

	updateControls();
}

function element(tag: string, className = '', text = ''): HTMLElement
{
	const node = document.createElement(tag);
	if(className) node.className = className;
	if(text) node.textContent = text;
	return node;
}

function renderMenu(menu: HTMLElement): void
{
	menu.replaceChildren();

	menu.appendChild(element('div', 'read-along-menu-title', 'Speed'));
	const chips = element('div', 'read-along-chips');

	for(const speed of SPEEDS)
	{
		const chip = element('span', 'read-along-chip' + (speed === options.speed ? ' active' : ''), speed + '×');
		chip.dataset.speed = String(speed);
		chips.appendChild(chip);
	}

	menu.appendChild(chips);

	menu.appendChild(element('div', 'read-along-menu-title', 'Voice'));
	const list = element('div', 'read-along-voices');
	list.appendChild(element('div', 'read-along-voice read-along-voice-off' + (!options.voice ? ' active' : ''), 'No voice, highlight only'));

	// Only the voices ticked in Settings → Read-along, grouped by engine
	const groups: {engine: Engine; title: string; note: string}[] = [
		{engine: 'kokoro', title: 'Kokoro', note: kokoroStatus()},
		{engine: 'pocket', title: 'Pocket TTS', note: pocketStatus()},
		{engine: 'system', title: 'System', note: ''},
	];

	let shown = 0;

	for(const group of groups)
	{
		const voices = readAlongVoices.shownVoices(group.engine);
		if(!voices.length) continue;

		shown += voices.length;
		list.appendChild(element('div', 'read-along-voice-group', group.title));
		if(group.note) list.appendChild(element('div', 'read-along-voice-note', group.note));

		for(const voice of voices)
		{
			const row = element('div', 'read-along-voice' + (isActive(voice) ? ' active' : ''), voice.name);
			row.appendChild(element('span', 'read-along-voice-lang', voice.detail));

			if(voice.engine === 'kokoro') row.dataset.kokoroVoice = voice.id;
			else if(voice.engine === 'pocket') row.dataset.pocketVoice = voice.id;
			else row.dataset.voice = voice.id;

			list.appendChild(row);
		}
	}

	if(!shown)
		list.appendChild(element('div', 'read-along-voice-note', 'No voices ticked. Pick some in Settings → Read-along.'));

	menu.appendChild(list);

	menu.appendChild(element('div', 'read-along-menu-title', 'Volume'));
	const volume = element('input', 'read-along-volume') as HTMLInputElement;
	volume.type = 'range';
	volume.min = '0';
	volume.max = '1';
	volume.step = '0.05';
	volume.value = String(options.volume);
	menu.appendChild(volume);

	const sfx = element('div', 'read-along-toggle' + (options.sfx ? ' on' : ''), 'Read sound effects');
	sfx.appendChild(element('span', 'read-along-switch'));
	menu.appendChild(sfx);
}

function kokoroStatus(): string
{
	switch(kokoro.state)
	{
		case 'loading':
			return kokoro.totalMB ? `Downloading… ${kokoro.downloadedMB} of ${kokoro.totalMB} MB` : 'Starting…';
		case 'ready':
			return `Ready, running on the ${kokoro.device === 'webgpu' ? 'GPU' : 'CPU'}`;
		case 'error':
			return `Couldn't load: ${kokoro.error}`;
		default:
			return 'Kokoro, runs on this PC. Downloads once (about 90–330 MB) on first use.';
	}
}

function pocketStatus(): string
{
	switch(pocket.state)
	{
		case 'installing':
		case 'starting':
			return pocket.progress || 'Starting…';
		case 'ready':
			return 'Ready, running on the CPU';
		case 'error':
			return `Couldn't start: ${pocket.error}`;
		case 'unsupported':
			return 'Not available on this system';
		case 'missing':
			return 'Runs on this PC. Downloads on first use (8 MB, plus a 46–215 MB model).';
		default:
			return 'Starts when it reads';
	}
}

// The menu entry of the voice that reads
function selectedKey(): string | false
{
	if(!options.voice) return false;
	if(options.engine === 'kokoro') return `kokoro:${options.kokoroVoice}`;
	if(options.engine === 'pocket') return `pocket:${options.pocketVoice}`;

	const system = systemVoices();
	const voice = chosenVoice() ?? system.find(voice => voice.default) ?? system[0];
	return voice ? `system:${voice.name}` : false;
}

function isActive(voice: CatalogVoice): boolean
{
	return selectedKey() === voice.key;
}

function setVoice(voice: CatalogVoice): void
{
	options.voice = true;
	options.engine = voice.engine;

	if(voice.engine === 'kokoro') options.kokoroVoice = voice.id;
	else if(voice.engine === 'pocket') options.pocketVoice = voice.id;
	else options.voiceName = voice.id;
}

// The voice was unticked in Settings (or deleted): switch to the first ticked one
function checkVoice(): void
{
	// System voices load late: don't judge by them before they're there
	const systemLoaded = systemVoices().length > 0;
	if(!options.voice || (options.engine === 'system' && !systemLoaded)) return;

	const key = selectedKey();
	const shown = readAlongVoices.shownVoices();
	if(shown.some(voice => voice.key === key)) return;

	if(shown.length) setVoice(shown[0]);
	else if(!systemLoaded) return;
	else options.voice = false;

	saveOptions();
}

// Picking a natural voice loads its engine if needed, then previews the voice
function chooseNaturalVoice(engine: 'kokoro' | 'pocket', id: string): void
{
	const voice = readAlongVoices.catalog(engine).find(voice => voice.id === id);
	if(!voice) return;

	setVoice(voice);
	saveOptions();

	if(playing)
	{
		go(current, true);
		return;
	}

	stopSpeaking();

	const preview = natural();
	if(!preview) return;

	const previewId = speechId;
	setWaiting(true);

	preview.synth(`Hi, I'm ${voice.name}.`).then(function(sound) {

		if(previewId !== speechId) return;
		setWaiting(false);
		stopSound = preview.play(sound, () => {});

	}).catch(function(error) {

		console.error(error);
		if(previewId === speechId) setWaiting(false);

	});
}

// Picking a voice previews it, or re-reads the current bubble while playing
function chooseVoice(name: string | false): void
{
	options.voice = name !== false;

	if(name !== false)
	{
		options.voiceName = name;
		options.engine = 'system';
	}

	saveOptions();

	if(playing)
	{
		go(current, true);
		return;
	}

	stopSpeaking();

	if(name !== false && systemVoices().length)
	{
		const voice = chosenVoice();
		speechSynthesis.speak(utterance(voice ? `Hi, I'm ${systemVoiceLabel(voice).replace(/^Microsoft\s+/, '')}.` : 'Hi.'));
	}
}

function closeMenuOutside(event: MouseEvent): void
{
	const bar = document.querySelector('.read-along-controls');

	if(bar?.classList.contains('menu-open') && !(event.target as HTMLElement).closest?.('.read-along-controls'))
	{
		// This click only closes the menu: it doesn't reach the page's tap zones
		event.stopPropagation();
		event.preventDefault();
		bar.classList.remove('menu-open');
		updateControls();
	}
}

function updateControls(): void
{
	const bar = document.querySelector('.read-along-controls');
	if(!bar) return;

	bar.querySelector('.read-along-play')!.textContent = playing ? 'pause' : 'play_arrow';
	bar.classList.toggle('playing', playing);

	const menu = bar.querySelector('.read-along-menu') as HTMLElement;

	if(bar.classList.contains('menu-open'))
		renderMenu(menu);
	else
		menu.replaceChildren();

	updateActive();
}

function rebuild(): void
{
	const item = items[current];
	items = [];
	document.querySelectorAll('oc-read-along').forEach(element => element.remove());

	const list = buildItems();
	current = item ? list.findIndex(i => i.bubble === item.bubble) : -1;
	if(current === -1 && item) current = firstOnPage(item.page) - 1;

	render();
}

function keydown(event: KeyboardEvent): void
{
	const bar = document.querySelector('.read-along-controls');

	// Esc closes the menu (instead of OpenComic going back to the library)
	if(event.code === 'Escape' && bar?.classList.contains('menu-open'))
	{
		event.preventDefault();
		event.stopPropagation();
		bar.classList.remove('menu-open');
		updateControls();
		return;
	}

	if(!data || !onReading || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

	const target = event.target as HTMLElement;
	if(target?.closest?.('input, textarea, [contenteditable]')) return;

	const actions: Record<string, () => void> = {
		KeyR: toggle,
		KeyJ: prev,
		KeyK: next,
	};

	const action = actions[event.code];
	if(!action) return;

	event.preventDefault();
	event.stopPropagation();
	action();
}

function removeControls(): void
{
	document.querySelectorAll('.read-along-controls').forEach(element => element.remove());
	document.removeEventListener('keydown', keydown, true);
	document.removeEventListener('click', closeMenuOutside, true);

	if(typeof speechSynthesis !== 'undefined')
		speechSynthesis.removeEventListener('voiceschanged', updateControls);

	kokoro.offChange(updateControls);
	pocket.offChange(updateControls);
}

function destroy(): void
{
	pause();
	removeControls();
	document.querySelectorAll('oc-read-along').forEach(element => element.remove());

	data = false;
	comicPath = '';
	items = [];
	current = -1;
}

export default {
	has,
	enabled,
	toggleMode,
	load,
	render,
	focusIndex,
	destroy,
	play,
	pause,
	next,
	prev,
	go,
	get items() {return buildItems()},
	get current() {return current},
	get playing() {return playing},
	get path() {return comicPath},
};
