import {
	type APIConnectOptions,
	type LanguageCode,
	stt,
} from "@livekit/agents";
import { type AudioFrame, combineAudioFrames } from "@livekit/rtc-node";
import { toWav } from "./maiStt.js";

/**
 * Batch speech-to-text through OpenRouter's `/audio/transcriptions` endpoint
 * (JSON with base64 audio). Works for any transcription model OpenRouter lists,
 * such as `openai/whisper-large-v3-turbo`. Whole sentences only; LiveKit wraps
 * it with VAD.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions";

export type OpenRouterTranscribeOptions = {
	apiKey?: string;
	model: string;
	onTiming?: (info: { ms: number; chars: number }) => void;
};

type TranscriptionResponse = { text?: string; language?: string };

export class OpenRouterTranscribeSTT extends stt.STT {
	label = "openrouter.OpenRouterTranscribeSTT";
	#apiKey: string;
	#model: string;
	#onTiming?: OpenRouterTranscribeOptions["onTiming"];

	constructor(opts: OpenRouterTranscribeOptions) {
		super({ streaming: false, interimResults: false });
		const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
		if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
		this.#apiKey = apiKey;
		this.#model = opts.model;
		this.#onTiming = opts.onTiming;
	}

	get model() {
		return this.#model;
	}

	get provider() {
		return "openrouter";
	}

	protected async _recognize(
		buffer: AudioFrame | AudioFrame[],
		abortSignal?: AbortSignal,
	): Promise<stt.SpeechEvent> {
		const frame = combineAudioFrames(buffer);
		const wav = toWav(frame).toString("base64");
		const t0 = Date.now();

		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.#model,
				input_audio: { data: wav, format: "wav" },
			}),
			signal: abortSignal,
		});
		if (!res.ok) {
			throw new Error(
				`OpenRouter transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
			);
		}
		const json = (await res.json()) as TranscriptionResponse;
		const text = (json.text ?? "").trim();
		this.#onTiming?.({ ms: Date.now() - t0, chars: text.length });

		return {
			type: stt.SpeechEventType.FINAL_TRANSCRIPT,
			alternatives: [
				{
					language: (json.language ??
						(/[؀-ۿ]/.test(text) ? "ar" : "en")) as LanguageCode,
					text,
					startTime: 0,
					endTime: frame.samplesPerChannel / frame.sampleRate,
					confidence: 1,
				},
			],
		};
	}

	stream(_options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
		throw new Error(
			"OpenRouterTranscribeSTT is not a streaming STT; use it through AgentSession with a VAD",
		);
	}
}
