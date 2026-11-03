import p from 'path';
import fs from 'fs';

import kokoro from './read-along-kokoro.mjs';
import pocket from './read-along-pocket.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const electronRemote: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Every read-along voice, and which of them the reader's voice menu lists.
// They're ticked in Settings → Read-along; until the first change the
// defaults below apply. Saved in <userData>/read-along/voices.json.

export type Engine = 'kokoro' | 'pocket' | 'system';

export interface CatalogVoice {
	key: string; // 'kokoro:af_heart', 'pocket:alba', 'pocket:custom:<id>', 'system:<voice name>'
	engine: Engine;
	id: string; // What the engine is given
	name: string;
	detail: string;
	custom?: boolean;
}

function file(): string
{
	return p.join(electronRemote.app.getPath('userData'), 'read-along', 'voices.json');
}

let shownCache: string[] | null | undefined;

function shownList(): string[] | null
{
	if(shownCache !== undefined) return shownCache;

	try
	{
		const list = JSON.parse(fs.readFileSync(file(), 'utf8')).shown;
		shownCache = Array.isArray(list) ? list.map(String) : null;
	}
	catch
	{
		shownCache = null;
	}

	return shownCache;
}

function save(list: string[]): void
{
	shownCache = list;
	fs.mkdirSync(p.dirname(file()), {recursive: true});
	fs.writeFileSync(file() + '.tmp', JSON.stringify({shown: list}, null, '\t'));
	fs.renameSync(file() + '.tmp', file());
}

export function systemVoices(): SpeechSynthesisVoice[]
{
	return typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
}

// "Microsoft Zira - English (United States)" -> "Microsoft Zira"
export function systemVoiceLabel(voice: SpeechSynthesisVoice): string
{
	return voice.name.replace(/\s+-\s+.*$/, '');
}

function catalog(engine?: Engine): CatalogVoice[]
{
	const list: CatalogVoice[] = [];

	if(!engine || engine === 'kokoro')
	{
		for(const voice of kokoro.VOICES)
			list.push({key: `kokoro:${voice.id}`, engine: 'kokoro', id: voice.id, name: voice.name, detail: `${voice.accent} ${voice.gender} · grade ${voice.grade}`});
	}

	if(!engine || engine === 'pocket')
	{
		for(const voice of pocket.VOICES)
			list.push({key: `pocket:${voice.id}`, engine: 'pocket', id: voice.id, name: voice.name, detail: voice.accent ? `${voice.gender}, ${voice.accent} speaker` : voice.gender});

		for(const voice of pocket.custom)
			list.push({key: `pocket:custom:${voice.id}`, engine: 'pocket', id: `custom:${voice.id}`, name: voice.name, detail: 'your voice', custom: true});
	}

	if(!engine || engine === 'system')
	{
		for(const voice of systemVoices())
			list.push({key: `system:${voice.name}`, engine: 'system', id: voice.name, name: systemVoiceLabel(voice), detail: voice.lang});
	}

	return list;
}

function isDefault(voice: CatalogVoice): boolean
{
	switch(voice.engine)
	{
		case 'kokoro': return kokoro.DEFAULT_VOICES.includes(voice.id);
		case 'pocket': return pocket.DEFAULT_VOICES.includes(voice.id) || !!voice.custom;
		default: return true;
	}
}

function isShown(voice: CatalogVoice): boolean
{
	const list = shownList();
	return list ? list.includes(voice.key) : isDefault(voice);
}

function setShown(keys: string[], shown: boolean): void
{
	// The first change turns the defaults into an explicit list
	const list = new Set(shownList() ?? catalog().filter(isDefault).map(voice => voice.key));

	for(const key of keys)
	{
		if(shown) list.add(key);
		else list.delete(key);
	}

	save([...list]);
}

// The ticked voices, in catalog order
function shownVoices(engine?: Engine): CatalogVoice[]
{
	return catalog(engine).filter(isShown);
}

export default {
	catalog,
	isShown,
	setShown,
	shownVoices,
	systemVoices,
	systemVoiceLabel,
};
