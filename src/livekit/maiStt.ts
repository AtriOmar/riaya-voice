import type { LanguageCode } from "@livekit/agents";
import { type APIConnectOptions, stt } from "@livekit/agents";
import { type AudioFrame, combineAudioFrames } from "@livekit/rtc-node";

/**
 * Microsoft MAI-Transcribe-2 through OpenRouter's `/audio/transcriptions`.
 * The endpoint takes a whole utterance (no streaming), so LiveKit wraps this
 * class with VAD automatically: each finished sentence is sent once.
 *
 * Language handling: MAI auto-detects the language (and handles Derja/French
 * code-switching) but can only be *forced* to a single language. To accept only
 * Arabic, French and English, a transcript whose detected language is outside
 * that set is re-requested with the caller's language forced.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions";
const MODEL = "microsoft/mai-transcribe-2";
const ALLOWED_LANGUAGES = new Set(["ar", "fr", "en"]);

/**
 * MAI/Whisper-style models sometimes return a 3-letter variant (e.g. `arb`,
 * `ara` for Arabic) instead of the 2-letter code. Matching only exact 2-letter
 * codes would treat those as "wrong language" and trigger an unnecessary
 * (and costly) re-transcription, so prefix-match against the allowed set too.
 */
function normalizeDetectedLanguage(
	raw: string | undefined,
): string | undefined {
	const code = raw?.toLowerCase().split("-")[0];
	if (!code) return undefined;
	if (ALLOWED_LANGUAGES.has(code)) return code;
	return [...ALLOWED_LANGUAGES].find((l) => code.startsWith(l));
}

export type MaiSTTOptions = {
	apiKey?: string;
	/** Language forced when the detected one is not Arabic, French or English. */
	fallbackLanguage?: string;
	/** Phrases that bias recognition (city and speciality names, brand). */
	phrases?: string[];
};

type OpenRouterTranscription = {
	text?: string;
	language?: string;
	duration?: number;
};

export function toWav(frame: AudioFrame): Buffer {
	const pcm = Buffer.from(
		frame.data.buffer,
		frame.data.byteOffset,
		frame.data.byteLength,
	);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(frame.channels, 22);
	header.writeUInt32LE(frame.sampleRate, 24);
	header.writeUInt32LE(frame.sampleRate * frame.channels * 2, 28);
	header.writeUInt16LE(frame.channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

export class MaiTranscribeSTT extends stt.STT {
	label = "openrouter.MaiTranscribeSTT";
	#apiKey: string;
	#fallbackLanguage: string;
	#phrases: string[];

	constructor(opts: MaiSTTOptions = {}) {
		super({ streaming: false, interimResults: false });
		const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
		if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
		this.#apiKey = apiKey;
		this.#fallbackLanguage = opts.fallbackLanguage ?? "ar";
		this.#phrases = opts.phrases ?? [];
	}

	get model() {
		return MODEL;
	}

	get provider() {
		return "openrouter";
	}

	/** Called when the caller's language changes mid-call. */
	setFallbackLanguage(language: string) {
		this.#fallbackLanguage = language;
	}

	async #request(
		wavBase64: string,
		language: string | undefined,
		signal?: AbortSignal,
	): Promise<OpenRouterTranscription> {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				input_audio: { data: wavBase64, format: "wav" },
				response_format: "verbose_json",
				...(language ? { language } : {}),
				...(this.#phrases.length > 0
					? {
							provider: {
								options: { azure: { phraseList: { phrases: this.#phrases } } },
							},
						}
					: {}),
			}),
			signal,
		});
		if (!res.ok) {
			throw new Error(
				`MAI transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
			);
		}
		return (await res.json()) as OpenRouterTranscription;
	}

	protected async _recognize(
		buffer: AudioFrame | AudioFrame[],
		abortSignal?: AbortSignal,
	): Promise<stt.SpeechEvent> {
		const frame = combineAudioFrames(buffer);
		const wav = toWav(frame).toString("base64");

		let result = await this.#request(wav, undefined, abortSignal);
		let detected = normalizeDetectedLanguage(result.language);
		if (result.text?.trim() && !detected) {
			result = await this.#request(wav, this.#fallbackLanguage, abortSignal);
			detected = normalizeDetectedLanguage(result.language);
		}

		const text = (result.text ?? "").trim();
		const language = (detected ?? this.#fallbackLanguage) as LanguageCode;
		const duration = frame.samplesPerChannel / frame.sampleRate;

		return {
			type: stt.SpeechEventType.FINAL_TRANSCRIPT,
			alternatives: [
				{ language, text, startTime: 0, endTime: duration, confidence: 1 },
			],
		};
	}

	stream(_options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
		// LiveKit wraps non-streaming STTs with `stt.StreamAdapter` + VAD itself.
		throw new Error(
			"MaiTranscribeSTT is not a streaming STT; use it through AgentSession with a VAD",
		);
	}
}
