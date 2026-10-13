import {
	type APIConnectOptions,
	type LanguageCode,
	stt,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { type AudioFrame, combineAudioFrames } from "@livekit/rtc-node";
import { GoogleTTS } from "./googleTts.js";
import { toWav } from "./maiStt.js";

/**
 * Gemini straight from Google's API (set GEMINI_PROVIDER=google). Delete this
 * file to drop the path.
 */

const GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_COMPAT_URL =
	"https://generativelanguage.googleapis.com/v1beta/openai/";

export type GoogleGeminiSTTOptions = {
	apiKey?: string;
	/** Google model id, e.g. `gemini-3.5-transcribe` (no `google/` prefix). */
	model?: string;
	onTiming?: (info: { ms: number; chars: number }) => void;
};

export class GoogleGeminiTranscribeSTT extends stt.STT {
	label = "google.GoogleGeminiTranscribeSTT";
	#apiKey: string;
	#model: string;
	#onTiming?: GoogleGeminiSTTOptions["onTiming"];

	constructor(opts: GoogleGeminiSTTOptions = {}) {
		super({ streaming: false, interimResults: false });
		const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
		if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
		this.#apiKey = apiKey;
		this.#model = opts.model ?? "gemini-3.5-transcribe";
		this.#onTiming = opts.onTiming;
	}

	get model() {
		return this.#model;
	}

	get provider() {
		return "generativelanguage.googleapis.com";
	}

	protected async _recognize(
		buffer: AudioFrame | AudioFrame[],
		abortSignal?: AbortSignal,
	): Promise<stt.SpeechEvent> {
		const frame = combineAudioFrames(buffer);
		const wav = toWav(frame).toString("base64");
		const t0 = Date.now();

		const res = await fetch(`${GENERATE_URL}/${this.#model}:generateContent`, {
			method: "POST",
			headers: {
				"x-goog-api-key": this.#apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				contents: [
					{
						parts: [{ inlineData: { mimeType: "audio/wav", data: wav } }],
					},
				],
				generationConfig: { temperature: 0 },
			}),
			signal: abortSignal,
		});
		if (!res.ok) {
			throw new Error(
				`Google Gemini transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
			);
		}
		// The transcription model returns its text in `audioTranscription`, not `text`.
		const json = (await res.json()) as {
			candidates?: {
				content?: {
					parts?: { audioTranscription?: { text?: string } }[];
				};
			}[];
		};
		const text = (json.candidates?.[0]?.content?.parts ?? [])
			.map((p) => p.audioTranscription?.text ?? "")
			.join("")
			.trim();
		this.#onTiming?.({ ms: Date.now() - t0, chars: text.length });

		return {
			type: stt.SpeechEventType.FINAL_TRANSCRIPT,
			alternatives: [
				{
					language: (/[؀-ۿ]/.test(text) ? "ar" : "fr") as LanguageCode,
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
			"GoogleGeminiTranscribeSTT is not a streaming STT; use it through AgentSession with a VAD",
		);
	}
}

export function createGoogleGeminiStt(opts: GoogleGeminiSTTOptions) {
	return new GoogleGeminiTranscribeSTT(opts);
}

export function createGoogleGeminiLlm(model: string) {
	return new openai.LLM({
		model,
		baseURL: OPENAI_COMPAT_URL,
		apiKey: process.env.GEMINI_API_KEY,
	});
}

export function createGoogleGeminiTts(model: string, voice: string) {
	return new GoogleTTS({ model, voice });
}
