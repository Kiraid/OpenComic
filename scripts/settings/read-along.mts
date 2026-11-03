import p from 'path';

import kokoro from '../reading/read-along-kokoro.mjs';
import pocket from '../reading/read-along-pocket.mjs';
import voices, {CatalogVoice, Engine} from '../reading/read-along-voices.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const events: any;
declare const template: any;
declare const language: any;
declare const electronRemote: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Settings → Read-along: hear every voice, tick the ones the reader's voice menu
// lists, download Pocket TTS and make custom Pocket voices from a clip.

const DEFAULT_TEXT = 'I\'ve been fighting for so long, I don\'t even remember what it was like to rest.';

const CHECK = '<div class="checkbox{active}"><input type="hidden"><div><svg viewBox="0 0 24 24"><path fill="none" stroke="white" d="M1.73,12.91 8.1,19.28 22.79,4.59"></path></svg></div></div>';

let root: HTMLElement | null = null;
const parts = new Map<string, string>(); // Last HTML of each part, to skip unchanged ones

let testText = DEFAULT_TEXT;
let testing: {key: string; playing: boolean} | null = null;
let testId = 0;
let stopTest: (() => void) | false = false;

let keyDraft = '';
let keyBusy = false;
let keyError = '';
let cloneBusy = '';
let cloneError = '';
let clipPath = '';

function escape(text: string): string
{
	return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

function message(reason: unknown): string
{
	return String((reason as Error)?.message || reason);
}

function snackbar(text: string): void
{
	events.snackbar({
		key: 'readAlongSettings',
		text: escape(text),
		duration: 6,
		update: true,
		buttons: [{text: language.buttons.dismiss, function: 'events.closeSnackbar();'}],
	});
}

function button(action: string, text: string, disabled = false, data = ''): string
{
	return `<div class="simple-button filled-tonal${disabled ? ' disable' : ''}" data-action="${action}"${data}><div class="touch-effect">${text}</div></div>`;
}

// --- Start and stop -----------------------------------------------------------

function start(): void
{
	cleanup();

	// The page being left stays in the DOM for a moment: look in the new one
	root = template._contentRight().querySelector('.settings-read-along');
	if(!root) return;

	parts.clear();
	keyError = cloneError = '';

	root.innerHTML = `
		<div class="read-along-settings">
			<p class="body-medium">Tick the voices you want in the reader's voice menu, and press play to hear one. Voices run on this PC: they download once, the first time they're used.</p>
			<label class="read-along-settings-label" for="read-along-settings-text">Test sentence</label>
			<input type="text" id="read-along-settings-text" class="read-along-settings-field" value="${escape(testText)}" spellcheck="false">

			<h2 class="headline-small">Kokoro</h2>
			<div data-part="kokoro"></div>

			<h2 class="headline-small">Pocket TTS</h2>
			<div data-part="pocket-status"></div>
			<div data-part="pocket-voices"></div>
			<h3 class="title-medium">Your own voices</h3>
			<div data-part="pocket-custom"></div>

			<h2 class="headline-small">System voices</h2>
			<div data-part="system"></div>

			<p class="read-along-settings-credits">Kokoro-82M by hexgrad (Apache-2.0). Pocket TTS by Kyutai (MIT; model weights CC BY 4.0). Each voice has its own licence.</p>
		</div>
	`;

	root.addEventListener('click', click);
	root.addEventListener('input', input);
	root.addEventListener('keydown', keydown);

	kokoro.onChange(render);
	pocket.onChange(render);
	if(typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', render);

	render();
}

function cleanup(): void
{
	stopTesting();

	kokoro.offChange(render);
	pocket.offChange(render);
	if(typeof speechSynthesis !== 'undefined') speechSynthesis.removeEventListener('voiceschanged', render);

	root?.removeEventListener('click', click);
	root?.removeEventListener('input', input);
	root?.removeEventListener('keydown', keydown);
	root = null;
}

// --- Render -------------------------------------------------------------------

function render(): void
{
	// The settings page was left: stop listening
	if(!root?.isConnected)
	{
		cleanup();
		return;
	}

	setPart('kokoro', kokoroPart());
	setPart('pocket-status', pocketStatusPart());
	setPart('pocket-voices', voiceList('pocket'));
	setPart('pocket-custom', customPart());
	setPart('system', voices.catalog('system').length ? voiceList('system') : '<p class="read-along-settings-note">No system voices on this PC.</p>');

	// Kept out of the part's HTML so typing doesn't rebuild the field
	const field = root.querySelector('[data-field="key"]') as HTMLInputElement | null;
	if(field && field.value !== keyDraft) field.value = keyDraft;

	// The tabs keep a fixed height: follow ours as it changes
	const tab = root.closest('.tabs-readAlong') as HTMLElement | null;
	if(tab?.classList.contains('active') && tab.parentElement)
		tab.parentElement.style.height = tab.getBoundingClientRect().height + 'px';
}

function setPart(name: string, html: string): void
{
	if(parts.get(name) === html) return;

	const element = root!.querySelector(`[data-part="${name}"]`);
	if(!element) return;

	parts.set(name, html);
	element.innerHTML = html;
}

function status(text: string, buttons = '', error = false): string
{
	return `<div class="read-along-settings-status${error ? ' error' : ''}"><span>${text}</span>${buttons ? `<div class="read-along-settings-buttons">${buttons}</div>` : ''}</div>`;
}

function kokoroPart(): string
{
	let line: string;

	switch(kokoro.state)
	{
		case 'loading':
			line = status(kokoro.totalMB ? `Downloading… ${kokoro.downloadedMB} of ${kokoro.totalMB} MB` : 'Starting…');
			break;
		case 'ready':
			line = status(`Ready, running on the ${kokoro.device === 'webgpu' ? 'GPU' : 'CPU'}.`);
			break;
		case 'error':
			line = status(`Couldn't load Kokoro: ${escape(kokoro.error)}`, button('kokoro-retry', 'Try again'), true);
			break;
		default:
			line = status('Loads when you play a voice. The first time it downloads about 90–330 MB (more with a GPU).');
	}

	return line + voiceList('kokoro');
}

function pocketStatusPart(): string
{
	const busy = pocket.state === 'installing' || pocket.state === 'starting' || !!cloneBusy;
	const remove = button('pocket-remove', 'Remove downloads', busy);
	let line = '';

	switch(pocket.state)
	{
		case 'unsupported':
			return status('Pocket TTS has no build for this system.', '', true);
		case 'missing':
			line = status('Not downloaded. The program is 8 MB; the voice model downloads the first time you play a voice.', button('pocket-install', language.buttons.download));
			break;
		case 'installing':
		case 'starting':
			line = status(escape(pocket.progress || 'Starting…'));
			break;
		case 'stopped':
			line = status('Downloaded. Starts when you play a voice.', remove);
			break;
		case 'ready':
			line = status('Ready, running on the CPU.', remove);
			break;
		case 'error':
			line = status(`Pocket TTS stopped: ${escape(pocket.error)}`, button('pocket-retry', 'Try again'), true);
			break;
	}

	const chips = pocket.MODELS.map(model => `<span class="read-along-settings-chip${model.id === pocket.model ? ' active' : ''}${busy ? ' disable' : ''}" data-action="pocket-model" data-model="${model.id}">${model.name} · ${model.size} MB</span>`).join('');

	return line + `
		<div class="read-along-settings-chips">${chips}</div>
		<p class="read-along-settings-note">Smaller models are faster but may sound less natural. Each one downloads the first time it's used.</p>
	`;
}

function customPart(): string
{
	if(pocket.state === 'unsupported') return '';

	if(!pocket.hasKey)
	{
		return `
			<p class="read-along-settings-note">Pocket TTS can copy a voice from a short recording. Making one needs a free Hugging Face key; the voices you make keep working without it.</p>
			<ol class="read-along-settings-steps">
				<li>Make a free account at <a href="https://huggingface.co/join" target="_blank">huggingface.co</a>.</li>
				<li>Accept Kyutai's terms on the <a href="${pocket.TERMS_URL}" target="_blank">Pocket TTS page</a>.</li>
				<li>Create a <b>Read</b> key on the <a href="${pocket.TOKENS_URL}" target="_blank">access tokens page</a> and paste it here.</li>
			</ol>
			<div class="read-along-settings-key">
				<input type="password" class="read-along-settings-field" data-field="key" placeholder="hf_…" spellcheck="false" autocomplete="off"${keyBusy ? ' disabled' : ''}>
				${button('key-save', keyBusy ? 'Checking…' : language.buttons.save, keyBusy)}
			</div>
			${keyError ? `<p class="read-along-settings-error">${escape(keyError)}</p>` : ''}
		`;
	}

	const user = pocket.keyUser ? ` for <b>${escape(pocket.keyUser)}</b>` : '';
	let html = status(`Hugging Face key saved${user}.`, button('key-remove', 'Remove key', keyBusy || !!cloneBusy));

	if(!pocket.keyAccess)
	{
		html += status(`This key can't download the voice-copying model yet. Accept the terms on the <a href="${pocket.TERMS_URL}" target="_blank">Pocket TTS page</a> while signed in, then check again.`, button('key-recheck', keyBusy ? 'Checking…' : 'Check again', keyBusy), true);
	}
	else
	{
		const progress = cloneBusy ? (pocket.cloning || cloneBusy) : '';
		html += `
			<div class="read-along-settings-buttons">${button('clone', '<i class="icon-24 material-icon">upload_file</i>Add a voice from a clip', !!cloneBusy || pocket.state === 'installing')}</div>
			<p class="read-along-settings-note">Use 10–30 seconds of one person speaking clearly, with no music or background noise. Only the first 30 seconds are used. The first voice also downloads the voice-copying model (about 220 MB).</p>
			${progress ? `<p class="read-along-settings-progress">${escape(progress)}</p>` : ''}
		`;
	}

	if(keyError) html += `<p class="read-along-settings-error">${escape(keyError)}</p>`;
	if(cloneError) html += `<p class="read-along-settings-error">${escape(cloneError)}</p>`;

	return html;
}

function voiceList(engine: Engine): string
{
	const list = voices.catalog(engine);
	if(!list.length) return '';

	const rows = list.map(function(voice) {

		const test = testing?.key === voice.key ? (testing.playing ? 'stop' : 'hourglass_top') : 'play_arrow';
		const title = testing?.key === voice.key ? (testing.playing ? 'Stop' : 'Making…') : 'Play';
		const edit = voice.custom ? `
			<span class="material-icon read-along-settings-icon" data-action="rename" title="Rename">edit</span>
			<span class="material-icon read-along-settings-icon" data-action="delete" title="Delete">delete</span>
		` : '';

		return `
			<div class="read-along-settings-voice" data-key="${escape(voice.key)}">
				${CHECK.replace('{active}', voices.isShown(voice) ? ' active' : '')}
				<div class="read-along-settings-voice-text"><div>${escape(voice.name)}</div><span>${escape(voice.detail)}</span></div>
				${edit}
				<span class="material-icon read-along-settings-icon${test !== 'play_arrow' ? ' active' : ''}" data-action="test" title="${title}">${test}</span>
			</div>
		`;

	}).join('');

	return `
		<div class="read-along-settings-buttons">
			${button('tick-all', 'All', false, ` data-engine="${engine}"`)}
			${button('tick-none', 'None', false, ` data-engine="${engine}"`)}
		</div>
		<div class="read-along-settings-voices">${rows}</div>
	`;
}

// --- Events -------------------------------------------------------------------

function voiceByKey(key: string): CatalogVoice | undefined
{
	return voices.catalog().find(voice => voice.key === key);
}

function click(event: MouseEvent): void
{
	const target = event.target as HTMLElement;
	if(target.closest('a')) return;

	const actionElement = target.closest('[data-action]') as HTMLElement | null;
	const row = target.closest('[data-key]') as HTMLElement | null;
	const voice = row ? voiceByKey(row.dataset.key!) : undefined;

	if(!actionElement)
	{
		// Clicking a voice row ticks or unticks it
		if(voice)
		{
			voices.setShown([voice.key], !voices.isShown(voice));
			render();
		}

		return;
	}

	if(actionElement.classList.contains('disable')) return;

	switch(actionElement.dataset.action)
	{
		case 'test':
			if(voice) test(voice);
			break;
		case 'rename':
			if(voice) rename(voice);
			break;
		case 'delete':
			if(voice) remove(voice);
			break;
		case 'tick-all':
		case 'tick-none':
			voices.setShown(voices.catalog(actionElement.dataset.engine as Engine).map(voice => voice.key), actionElement.dataset.action === 'tick-all');
			render();
			break;
		case 'kokoro-retry':
			kokoro.load().catch(() => {});
			break;
		case 'pocket-install':
			pocket.install().catch(() => {});
			break;
		case 'pocket-retry':
			pocket.start().catch(() => {});
			break;
		case 'pocket-remove':
			confirmRemoveDownloads(false);
			break;
		case 'pocket-model':
			stopTesting();
			pocket.setModel(actionElement.dataset.model!);
			break;
		case 'key-save':
			saveKey();
			break;
		case 'key-recheck':
			recheckKey();
			break;
		case 'key-remove':
			pocket.clearKey();
			keyDraft = keyError = cloneError = '';
			break;
		case 'clone':
			pickClip();
			break;
	}
}

function input(event: Event): void
{
	const target = event.target as HTMLInputElement;

	if(target.id === 'read-along-settings-text') testText = target.value;
	else if(target.dataset.field === 'key') keyDraft = target.value;
}

function keydown(event: KeyboardEvent): void
{
	const target = event.target as HTMLInputElement;

	if(event.key === 'Enter' && target.dataset?.field === 'key')
	{
		event.preventDefault();
		saveKey();
	}
}

// --- Test playback ------------------------------------------------------------

function stopTesting(): void
{
	testId++;

	if(stopTest) stopTest();
	stopTest = false;

	if(testing?.key.startsWith('system:') && typeof speechSynthesis !== 'undefined')
		speechSynthesis.cancel();

	testing = null;
}

async function test(voice: CatalogVoice, text = testText.trim() || DEFAULT_TEXT): Promise<void>
{
	// The button stops the voice being tested
	if(testing?.key === voice.key)
	{
		stopTesting();
		render();
		return;
	}

	stopTesting();

	const id = testId;
	testing = {key: voice.key, playing: false};
	render();

	const finish = function() {

		if(id !== testId) return;

		testing = null;
		stopTest = false;
		render();

	};

	const playing = function() {

		if(id !== testId) return;

		testing = {key: voice.key, playing: true};
		render();

	};

	try
	{
		if(voice.engine === 'system')
		{
			const system = voices.systemVoices().find(system => system.name === voice.id);
			if(!system) throw new Error('This voice isn\'t on this PC anymore');

			const speech = new SpeechSynthesisUtterance(text);
			speech.voice = system;
			speech.onstart = playing;
			speech.onend = finish;
			speech.onerror = finish;
			speechSynthesis.speak(speech);
			return;
		}

		if(voice.engine === 'kokoro')
		{
			const sound = await kokoro.synth(text, voice.id, 1);
			if(id !== testId) return;

			stopTest = kokoro.play(sound, 1, finish);
		}
		else
		{
			const sound = await pocket.synth(text, voice.id);
			if(id !== testId) return;

			stopTest = pocket.play(sound, 1, 1, finish);
		}

		playing();
	}
	catch (reason)
	{
		if(id !== testId) return;

		testing = null;
		render();
		snackbar(`${voice.name}: ${message(reason)}`);
	}
}

// --- Hugging Face key ---------------------------------------------------------

async function saveKey(): Promise<void>
{
	if(keyBusy) return;

	keyBusy = true;
	keyError = '';
	render();

	try
	{
		await pocket.setKey(keyDraft);
		keyDraft = '';
	}
	catch (reason)
	{
		keyError = message(reason);
	}

	keyBusy = false;
	render();
}

async function recheckKey(): Promise<void>
{
	if(keyBusy) return;

	keyBusy = true;
	keyError = '';
	render();

	try
	{
		await pocket.recheckKey();
	}
	catch (reason)
	{
		keyError = message(reason);
	}

	keyBusy = false;
	render();
}

// --- Custom voices ------------------------------------------------------------

function nameInput(value: string): string
{
	return `
		<div class="input">
			<div>
				<div class="inputBorder">
					<div class="left"></div>
					<div class="right"></div>
					<div class="top"><div></div><span></span></div>
					<div class="bottom"></div>
				</div>
				<div class="placeholder">Name</div>
				<input type="text" value="${escape(value)}" class="read-along-voice-name" spellcheck="false">
			</div>
		</div>
	`;
}

function dialogName(): string
{
	return (document.querySelector('.dialogs .read-along-voice-name') as HTMLInputElement | null)?.value.trim() || '';
}

async function pickClip(): Promise<void>
{
	const result = await electronRemote.dialog.showOpenDialog({
		properties: ['openFile'],
		filters: [{name: 'Audio', extensions: pocket.CLIP_EXTENSIONS}],
	});

	if(result.canceled || !result.filePaths?.[0]) return;

	clipPath = result.filePaths[0];
	cloneError = '';

	events.dialog({
		header: 'New voice',
		width: 400,
		height: false,
		content: `<p>Made from <b>${escape(p.basename(clipPath))}</b>. What should it be called?</p>${nameInput(p.basename(clipPath, p.extname(clipPath)).slice(0, 40))}`,
		buttons: [
			{text: language.buttons.cancel, function: 'events.closeDialog();'},
			{text: 'Make voice', function: 'settings.readAlong.confirmClip();'},
		],
	});

	events.eventInput();
}

async function confirmClip(): Promise<void>
{
	const name = dialogName();

	if(!name)
	{
		snackbar('Give the voice a name');
		return;
	}

	if(pocket.custom.some(custom => custom.name.toLowerCase() === name.toLowerCase()))
	{
		snackbar(`There's already a voice called ${name}`);
		return;
	}

	events.closeDialog();
	stopTesting();

	cloneBusy = `Making ${name}…`;
	cloneError = '';
	render();

	try
	{
		const custom = await pocket.addVoice(clipPath, name);
		const key = `pocket:custom:${custom.id}`;
		voices.setShown([key], true);

		cloneBusy = '';
		render();

		const voice = voiceByKey(key);
		if(voice && root?.isConnected) test(voice, `Hi, I'm ${name}. ${testText.trim() || DEFAULT_TEXT}`);
	}
	catch (reason)
	{
		cloneBusy = '';
		cloneError = `Couldn't make ${name}: ${message(reason)}`;
		render();
	}
}

function rename(voice: CatalogVoice): void
{
	events.dialog({
		header: 'Rename voice',
		width: 400,
		height: false,
		content: nameInput(voice.name),
		buttons: [
			{text: language.buttons.cancel, function: 'events.closeDialog();'},
			{text: language.buttons.save, function: `settings.readAlong.confirmRename('${voice.id.slice(7)}');`},
		],
	});

	events.eventInput();
}

function confirmRename(id: string): void
{
	const name = dialogName();

	if(!name)
	{
		snackbar('Give the voice a name');
		return;
	}

	events.closeDialog();
	pocket.renameVoice(id, name);
}

function remove(voice: CatalogVoice): void
{
	events.dialog({
		header: 'Delete voice',
		width: 400,
		height: false,
		content: `<p>Delete <b>${escape(voice.name)}</b> and the clip it was made from?</p>`,
		buttons: [
			{text: language.buttons.cancel, function: 'events.closeDialog();'},
			{text: language.buttons.delete, function: `events.closeDialog(); settings.readAlong.confirmDelete('${voice.id.slice(7)}');`},
		],
	});
}

async function confirmDelete(id: string): Promise<void>
{
	if(testing?.key === `pocket:custom:${id}`) stopTesting();

	voices.setShown([`pocket:custom:${id}`], false);
	await pocket.removeVoice(id);
}

function confirmRemoveDownloads(confirmed = true): void
{
	if(!confirmed)
	{
		events.dialog({
			header: 'Remove Pocket TTS downloads',
			width: 400,
			height: false,
			content: '<p>Deletes the program and its voice models. Your own voices are kept and are remade from their clips the next time they\'re used (that needs your Hugging Face key).</p>',
			buttons: [
				{text: language.buttons.cancel, function: 'events.closeDialog();'},
				{text: language.buttons.remove, function: 'events.closeDialog(); settings.readAlong.confirmRemoveDownloads();'},
			],
		});

		return;
	}

	stopTesting();
	pocket.remove().catch(reason => snackbar(message(reason)));
}

export default {
	start,
	confirmClip,
	confirmRename,
	confirmDelete,
	confirmRemoveDownloads,
};
