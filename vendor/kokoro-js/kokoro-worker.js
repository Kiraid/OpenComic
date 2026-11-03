// Kokoro text-to-speech worker for OpenComic's read-along voices.
// Started from kokoro-frame.html's realm, so it has no Node integration and
// transformers.js / onnxruntime-web use their browser backends.
//
// in:  {type: 'load', device}                       -> progress..., ready | error
//      {type: 'generate', id, text, voice, speed}   -> audio | error
// The model downloads from Hugging Face on first use and is kept in the
// browser cache (Cache Storage) after that.

import {KokoroTTS} from './kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null;
let queue = Promise.resolve(); // One generation at a time

async function load(device)
{
	const progress = {};

	const options = (device) => ({
		device,
		// WebGPU needs the full-precision model; WASM runs the 8-bit one (smaller, faster on CPU)
		dtype: device === 'webgpu' ? 'fp32' : 'q8',
		progress_callback: (event) => {

			if(!event.file || event.status !== 'progress') return;

			progress[event.file] = {loaded: event.loaded || 0, total: event.total || 0};
			const loaded = Object.values(progress).reduce((sum, file) => sum + file.loaded, 0);
			const total = Object.values(progress).reduce((sum, file) => sum + file.total, 0);
			postMessage({type: 'progress', loaded, total});

		},
	});

	try
	{
		tts = await KokoroTTS.from_pretrained(MODEL, options(device));
	}
	catch(error)
	{
		if(device !== 'webgpu') throw error;
		device = 'wasm';
		tts = await KokoroTTS.from_pretrained(MODEL, options(device));
	}

	postMessage({type: 'ready', device});
}

onmessage = (event) => {

	const message = event.data;

	if(message.type === 'load')
	{
		load(message.device).catch((error) => postMessage({type: 'error', message: String(error?.message || error)}));
	}
	else if(message.type === 'generate')
	{
		queue = queue.then(async () => {

			try
			{
				const result = await tts.generate(message.text, {voice: message.voice, speed: message.speed});
				const audio = result.audio;
				postMessage({type: 'audio', id: message.id, audio, rate: result.sampling_rate}, [audio.buffer]);
			}
			catch(error)
			{
				postMessage({type: 'error', id: message.id, message: String(error?.message || error)});
			}

		});
	}

};
