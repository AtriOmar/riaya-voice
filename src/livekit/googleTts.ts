import {
	type APIConnectOptions,
	AudioByteStream,
	shortuuid,
	tts,
} from "@livekit/agents";

/**
 * Gemini TTS straight from Google's API (`streamGenerateContent`, SSE). Audio is
 * pushed to the agent as each chunk arrives, so the first sound plays well
 * before the whole reply is generated — unlike OpenRouter, which only returns
 * audio once generation is nearly finished.
 */

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export type GoogleTTSOptions = {
	apiKey?: string;
	/** e.g. `gemini-3.8-flash-lite-tts` (Google's own model id, no `google/` prefix). */
	model?: string;
	/** Prebuilt Gemini voice, e.g. `Charon`. */
	voice?: string;
};

type ResolvedOptions = Required<GoogleTTSOptions>;

export class GoogleTTS extends tts.TTS {
	label = "google.GoogleTTS";
	#opts: ResolvedOptions;
	#abort = new AbortController();

	constructor(opts: GoogleTTSOptions = {}) {
		super(SAMPLE_RATE, CHANNELS, { streaming: false });
		const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
		if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
		this.#opts = {
			apiKey,
			model: opts.model ?? "gemini-3.8-flash-lite-tts",
			voice: opts.voice ?? "Charon",
		};
	}

	get model() {
		return this.#opts.model;
	}

	get provider() {
		return "generativelanguage.googleapis.com";
	}

	updateOptions(opts: Pick<GoogleTTSOptions, "voice" | "model">) {
		this.#opts = {
			...this.#opts,
			...(opts.voice ? { voice: opts.voice } : {}),
			...(opts.model ? { model: opts.model } : {}),
		};
	}

	synthesize(
		text: string,
		connOptions?: APIConnectOptions,
		abortSignal?: AbortSignal,
	): tts.ChunkedStream {
		const signal = abortSignal
			? AbortSignal.any([abortSignal, this.#abort.signal])
			: this.#abort.signal;
		return new GoogleChunkedStream(
			this,
			text,
			{ ...this.#opts },
			connOptions,
			signal,
		);
	}

	stream(): tts.SynthesizeStream {
		throw new Error("Streaming input is not supported on Google TTS");
	}

	async close() {
		this.#abort.abort();
	}
}

class GoogleChunkedStream extends tts.ChunkedStream {
	label = "google.ChunkedStream";
	#opts: ResolvedOptions;
	#signal: AbortSignal;

	constructor(
		ttsInstance: GoogleTTS,
		text: string,
		opts: ResolvedOptions,
		connOptions: APIConnectOptions | undefined,
		signal: AbortSignal,
	) {
		super(text, ttsInstance, connOptions, signal);
		this.#opts = opts;
		this.#signal = signal;
	}

	protected async run() {
		try {
			const res = await fetch(
				`${BASE_URL}/${this.#opts.model}:streamGenerateContent?alt=sse`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-goog-api-key": this.#opts.apiKey,
					},
					body: JSON.stringify({
						contents: [{ parts: [{ text: this.inputText }] }],
						generationConfig: {
							responseModalities: ["AUDIO"],
							speechConfig: {
								voiceConfig: {
									prebuiltVoiceConfig: { voiceName: this.#opts.voice },
								},
							},
						},
					}),
					signal: this.#signal,
				},
			);
			if (!res.ok || !res.body) {
				const detail = (await res.text().catch(() => "")).slice(0, 300);
				throw new Error(`Google TTS failed: ${res.status} ${detail}`);
			}

			const requestId = shortuuid();
			const bytes = new AudioByteStream(SAMPLE_RATE, CHANNELS);
			let last: ReturnType<AudioByteStream["write"]>[number] | undefined;
			const emit = (final: boolean) => {
				if (!last) return;
				this.queue.put({ requestId, segmentId: requestId, frame: last, final });
				last = undefined;
			};
			const push = (frames: ReturnType<AudioByteStream["write"]>) => {
				for (const frame of frames) {
					emit(false);
					last = frame;
				}
			};

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let pending = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				pending += decoder.decode(value, { stream: true });
				const lines = pending.split(/\r?\n/);
				pending = lines.pop() ?? "";
				for (const line of lines) {
					const pcm = audioFromSseLine(line);
					if (!pcm) continue;
					push(
						bytes.write(
							pcm.buffer.slice(
								pcm.byteOffset,
								pcm.byteOffset + pcm.byteLength,
							) as ArrayBuffer,
						),
					);
				}
			}
			const tail = audioFromSseLine(pending);
			if (tail) {
				push(
					bytes.write(
						tail.buffer.slice(
							tail.byteOffset,
							tail.byteOffset + tail.byteLength,
						) as ArrayBuffer,
					),
				);
			}
			push(bytes.flush());
			emit(true);
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") return;
			throw error;
		} finally {
			this.queue.close();
		}
	}
}

function audioFromSseLine(line: string): Buffer | null {
	if (!line.startsWith("data:")) return null;
	const json = line.slice(5).trim();
	if (!json) return null;
	try {
		const event = JSON.parse(json) as {
			candidates?: {
				content?: { parts?: { inlineData?: { data?: string } }[] };
			}[];
		};
		const parts = event.candidates?.[0]?.content?.parts ?? [];
		const chunks = parts.flatMap((p) =>
			p.inlineData?.data ? [Buffer.from(p.inlineData.data, "base64")] : [],
		);
		return chunks.length > 0 ? Buffer.concat(chunks) : null;
	} catch {
		return null;
	}
}
