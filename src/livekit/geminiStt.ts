import {
	type APIConnectOptions,
	type LanguageCode,
	stt,
} from "@livekit/agents";
import { type AudioFrame, combineAudioFrames } from "@livekit/rtc-node";
import {
	buildGeminiTranscriptPrompt,
	maxTranscriptTokens,
} from "./geminiPrompt.js";
import { toWav } from "./maiStt.js";

/**
 * Speech-to-text with a regular Gemini model through OpenRouter chat
 * completions (audio in, transcript out). Whole sentences only, so LiveKit
 * wraps it with VAD automatically. The prompt restricts the output to Derja,
 * French and English and tells the model to keep words as spoken.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type GeminiSTTOptions = {
	apiKey?: string;
	model?: string;
	/** Phrases to bias spelling (city and speciality names). */
	phrases?: string[];
	/** `none` for models that put their answer in the reasoning field (e.g. xiaomi/mimo). */
	reasoningEffort?: "none" | "minimal";
	onTiming?: (info: { ms: number; chars: number }) => void;
};

export class GeminiTranscribeSTT extends stt.STT {
	label = "openrouter.GeminiTranscribeSTT";
	#apiKey: string;
	#model: string;
	#prompt: string;
	#onTiming?: GeminiSTTOptions["onTiming"];
	#reasoningEffort: "none" | "minimal";

	constructor(opts: GeminiSTTOptions = {}) {
		super({ streaming: false, interimResults: false });
		const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
		if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
		this.#apiKey = apiKey;
		this.#model = opts.model ?? "google/gemini-3.8-flash";
		this.#prompt = buildGeminiTranscriptPrompt(opts.phrases ?? []);
		this.#onTiming = opts.onTiming;
		this.#reasoningEffort = opts.reasoningEffort ?? "minimal";
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
				reasoning: { effort: this.#reasoningEffort },
				max_tokens: maxTranscriptTokens(
					frame.samplesPerChannel / frame.sampleRate,
				),
				temperature: 0,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: this.#prompt },
							{
								type: "input_audio",
								input_audio: { data: wav, format: "wav" },
							},
						],
					},
				],
			}),
			signal: abortSignal,
		});
		if (!res.ok) {
			throw new Error(
				`Gemini transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
			);
		}
		const json = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const text = (json.choices?.[0]?.message?.content ?? "").trim();
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
		// LiveKit wraps non-streaming STTs with `stt.StreamAdapter` + VAD itself.
		throw new Error(
			"GeminiTranscribeSTT is not a streaming STT; use it through AgentSession with a VAD",
		);
	}
}
