import type { Logger } from "pino";

/**
 * Separate transcription of the caller on the phone stream. The realtime model
 * keeps running the conversation; this splits the caller's G.711 μ-law audio
 * into sentences with a simple energy check and sends each one to a
 * transcription model on OpenRouter. Turn it off (CALLER_STT=off) to use the
 * realtime model's own input transcript instead.
 */

const SAMPLE_RATE = 8000;
const BYTES_PER_MS = SAMPLE_RATE / 1000;
const PREROLL_MS = 200;

import {
	buildGeminiTranscriptPrompt,
	maxTranscriptTokens,
} from "../livekit/geminiPrompt.js";

const TRANSCRIPTION_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const ULAW_TO_LINEAR = (() => {
	const table = new Int16Array(256);
	for (let i = 0; i < 256; i++) {
		const u = ~i & 0xff;
		const exponent = (u >> 4) & 0x07;
		const mantissa = u & 0x0f;
		const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
		table[i] = u & 0x80 ? -sample : sample;
	}
	return table;
})();

function envInt(name: string, fallback: number) {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

function wavFromPcm16(pcm: Int16Array): Buffer {
	const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

export type CallerTranscriberOptions = {
	logger: Logger;
	apiKey: string;
	/** OpenRouter model id. `transcription`: a transcription model. `chat`: a chat model with audio input (e.g. Gemini 2.5 Flash). */
	model: string;
	api: "transcription" | "chat";
	reasoningEffort?: "none" | "minimal";
	onTranscript: (text: string) => void;
};

export class CallerTranscriber {
	private readonly silenceMs = envInt("CALLER_STT_SILENCE_MS", 700);
	private readonly minSpeechMs = envInt("CALLER_STT_MIN_SPEECH_MS", 250);
	private readonly maxUtteranceMs = envInt(
		"CALLER_STT_MAX_UTTERANCE_MS",
		20000,
	);
	private readonly minThreshold =
		envInt("CALLER_STT_THRESHOLD_PERMILLE", 12) / 1000;

	private speaking = false;
	private speechMs = 0;
	private quietMs = 0;
	private totalMs = 0;
	private noise = 0.003;
	private chunks: Int16Array[] = [];
	private preroll: Int16Array[] = [];
	private prerollMs = 0;
	private closed = false;
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly opts: CallerTranscriberOptions) {}

	/** Feed one base64 μ-law frame of caller audio (Twilio sends 20 ms). */
	push(mulawBase64: string) {
		if (this.closed) return;
		const bytes = Buffer.from(mulawBase64, "base64");
		if (bytes.length === 0) return;

		const pcm = new Int16Array(bytes.length);
		let sum = 0;
		for (let i = 0; i < bytes.length; i++) {
			const sample = ULAW_TO_LINEAR[bytes[i]];
			pcm[i] = sample;
			sum += sample * sample;
		}
		const rms = Math.sqrt(sum / bytes.length) / 32768;
		const ms = bytes.length / BYTES_PER_MS;
		const loud = rms > Math.max(this.minThreshold, this.noise * 3);

		if (!this.speaking) {
			if (!loud) {
				this.noise = this.noise * 0.95 + rms * 0.05;
				this.preroll.push(pcm);
				this.prerollMs += ms;
				while (this.prerollMs > PREROLL_MS && this.preroll.length > 1) {
					const dropped = this.preroll.shift();
					if (dropped) this.prerollMs -= dropped.length / BYTES_PER_MS;
				}
				return;
			}
			this.speaking = true;
			this.chunks = [...this.preroll, pcm];
			this.totalMs = this.prerollMs + ms;
			this.speechMs = ms;
			this.quietMs = 0;
			this.preroll = [];
			this.prerollMs = 0;
			return;
		}

		this.chunks.push(pcm);
		this.totalMs += ms;
		if (loud) {
			this.speechMs += ms;
			this.quietMs = 0;
		} else {
			this.quietMs += ms;
		}
		if (this.quietMs >= this.silenceMs || this.totalMs >= this.maxUtteranceMs) {
			this.flush();
		}
	}

	/** End the current sentence and send it for transcription. */
	flush() {
		const chunks = this.chunks;
		const speechMs = this.speechMs;
		this.speaking = false;
		this.chunks = [];
		this.speechMs = 0;
		this.quietMs = 0;
		this.totalMs = 0;
		if (chunks.length === 0 || speechMs < this.minSpeechMs) return;

		const length = chunks.reduce((n, c) => n + c.length, 0);
		const pcm = new Int16Array(length);
		let offset = 0;
		for (const c of chunks) {
			pcm.set(c, offset);
			offset += c.length;
		}
		const wav = wavFromPcm16(pcm).toString("base64");
		// Sequential, so transcripts keep the order the caller spoke them.
		this.queue = this.queue.then(() =>
			this.transcribe(wav, length / SAMPLE_RATE),
		);
	}

	close() {
		if (this.closed) return;
		if (this.speaking) this.flush();
		this.closed = true;
	}

	private async transcribe(wavBase64: string, seconds: number) {
		const t0 = Date.now();
		try {
			const headers = {
				Authorization: `Bearer ${this.opts.apiKey}`,
				"Content-Type": "application/json",
			};
			const res =
				this.opts.api === "chat"
					? await fetch(CHAT_URL, {
							method: "POST",
							headers,
							body: JSON.stringify({
								model: this.opts.model,
								temperature: 0,
								reasoning: { effort: this.opts.reasoningEffort ?? "minimal" },
								max_tokens: maxTranscriptTokens(seconds),
								messages: [
									{
										role: "user",
										content: [
											{ type: "text", text: buildGeminiTranscriptPrompt([]) },
											{
												type: "input_audio",
												input_audio: { data: wavBase64, format: "wav" },
											},
										],
									},
								],
							}),
						})
					: await fetch(TRANSCRIPTION_URL, {
							method: "POST",
							headers,
							body: JSON.stringify({
								model: this.opts.model,
								input_audio: { data: wavBase64, format: "wav" },
							}),
						});
			if (!res.ok) {
				throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
			}
			const json = (await res.json()) as {
				text?: string;
				choices?: { message?: { content?: string } }[];
			};
			const text = (
				this.opts.api === "chat"
					? (json.choices?.[0]?.message?.content ?? "")
					: (json.text ?? "")
			).trim();
			this.opts.logger.info(
				{
					ms: Date.now() - t0,
					seconds: Math.round(seconds * 10) / 10,
					chars: text.length,
				},
				"🎙️ Caller transcribed",
			);
			if (text) this.opts.onTranscript(text);
		} catch (error) {
			this.opts.logger.warn({ error }, "Caller transcription failed (ignored)");
		}
	}
}
