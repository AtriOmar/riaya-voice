import type { Logger } from "pino";
import { type RawData, WebSocket } from "ws";
import { mulaw8kToPcm16k, Pcm24kToMulaw8k } from "../utils/audioResample.js";
import type {
	RealtimeFunctionCall,
	RealtimeHandlers,
	RealtimeProvider,
	RealtimeSessionConfig,
} from "./types.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-live";
const GEMINI_VOICE = process.env.GEMINI_VOICE?.trim() || "Puck";
/** low | medium | high — required by `*-extended-thinking` models, optional otherwise. */
const GEMINI_THINKING_LEVEL =
	process.env.GEMINI_THINKING_LEVEL?.trim() ||
	(GEMINI_MODEL.includes("thinking") ? "low" : undefined);
const SILENCE_DURATION_MS = parseInt(
	process.env.SILENCE_DURATION_MS || "600",
	10,
);

const LIVE_URL =
	"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

type GeminiServerMessage = {
	setupComplete?: object;
	serverContent?: {
		modelTurn?: {
			parts?: { inlineData?: { mimeType?: string; data?: string } }[];
		};
		turnComplete?: boolean;
		interrupted?: boolean;
		inputTranscription?: { text?: string };
		outputTranscription?: { text?: string };
	};
	toolCall?: {
		functionCalls?: {
			id: string;
			name: string;
			args?: Record<string, unknown>;
		}[];
	};
	toolCallCancellation?: { ids?: string[] };
	goAway?: { timeLeft?: string };
	usageMetadata?: unknown;
};

/**
 * Google Gemini Live API over raw WebSocket. Unlike OpenAI, config (system
 * instruction, tools) is sent once in `setup` and cannot change mid-session,
 * and audio is PCM16 (16 kHz in / 24 kHz out), so we resample to/from μ-law.
 */
export class GeminiLiveProvider implements RealtimeProvider {
	readonly name = "gemini";
	private ws: WebSocket | null = null;
	private setupComplete = false;
	private started = false;
	private closing = false;
	private pendingGreeting: string | null = null;
	private readonly downsampler = new Pcm24kToMulaw8k();

	/** Gemini streams caller transcription in fragments; flush once the model replies. */
	private patientTranscript = "";
	private aiTranscript = "";

	constructor(
		private readonly logger: Logger,
		private readonly handlers: RealtimeHandlers,
	) {}

	connect(): Promise<void> {
		if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
		this.logger.info(`🔌 Connecting to Gemini Live (${GEMINI_MODEL})`);

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${LIVE_URL}?key=${GEMINI_API_KEY}`);
			this.ws = ws;

			ws.on("open", () => {
				this.logger.info("🟢 Gemini WebSocket connected");
				resolve();
				this.handlers.onReady();
			});
			ws.on("error", (error) => {
				this.logger.error({ error }, "🔥 Gemini WebSocket error");
				reject(error);
			});
			ws.on("message", (data: RawData) => this.handleMessage(data));
			ws.on("close", (code, reason) => {
				const why = reason.toString();
				this.logger.info({ code, reason: why }, "🔴 Gemini WebSocket closed");
				// Gemini reports fatal errors (bad setup, quota, …) as a close reason.
				if (code !== 1000 && why) this.handlers.onError(why, { code });
				this.handlers.onClose();
			});
		});
	}

	private send(payload: unknown) {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(payload));
	}

	start(config: RealtimeSessionConfig, greetingInstructions: string) {
		if (this.started) return;
		this.started = true;
		this.pendingGreeting = greetingInstructions;
		this.send({
			setup: {
				model: `models/${GEMINI_MODEL}`,
				generationConfig: {
					responseModalities: ["AUDIO"],
					speechConfig: {
						voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } },
					},
					...(GEMINI_THINKING_LEVEL
						? { thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL } }
						: {}),
				},
				systemInstruction: { parts: [{ text: config.instructions }] },
				tools: [
					{
						functionDeclarations: config.tools.map(
							({ name, description, parameters }) => ({
								name,
								description,
								parameters,
							}),
						),
					},
				],
				realtimeInputConfig: {
					automaticActivityDetection: {
						silenceDurationMs: SILENCE_DURATION_MS,
					},
				},
				inputAudioTranscription: {},
				outputAudioTranscription: {},
				// Audio-only sessions are otherwise capped (~15 min).
				contextWindowCompression: { slidingWindow: {} },
			},
		});
		this.logger.info("✅ Session setup sent to Gemini");
	}

	updateSession() {
		// Live API has no mid-session config update; instructions already tell the
		// model to switch language on request, so the change still takes effect.
		this.logger.info(
			"ℹ️ Gemini: mid-session config update not supported, skipped",
		);
	}

	sendAudio(mulawBase64: string) {
		if (!this.setupComplete || this.closing) return;
		this.send({
			realtimeInput: {
				audio: {
					mimeType: "audio/pcm;rate=16000",
					data: mulaw8kToPcm16k(mulawBase64),
				},
			},
		});
	}

	truncate() {
		// Gemini truncates its own context when it reports `interrupted`.
	}

	sendFunctionResult(call: RealtimeFunctionCall, output: string) {
		let response: unknown;
		try {
			response = JSON.parse(output);
		} catch {
			response = output;
		}
		// Gemini continues the turn on its own once the tool response arrives.
		this.send({
			toolResponse: {
				functionResponses: [
					{ id: call.callId, name: call.name, response: { output: response } },
				],
			},
		});
	}

	enterClosingMode() {
		// No VAD toggle mid-session: just stop forwarding caller audio.
		this.closing = true;
	}

	close() {
		if (!this.ws) return;
		this.ws.removeAllListeners();
		if (
			this.ws.readyState !== WebSocket.CLOSED &&
			this.ws.readyState !== WebSocket.CLOSING
		) {
			this.ws.close();
		}
	}

	private flushPatientTranscript() {
		const text = this.patientTranscript.trim();
		this.patientTranscript = "";
		if (text) this.handlers.onPatientTranscript(text);
	}

	private flushAiTranscript() {
		const text = this.aiTranscript.trim();
		this.aiTranscript = "";
		if (text) this.handlers.onAiTranscriptDone(text);
	}

	private handleMessage(data: RawData) {
		let msg: GeminiServerMessage;
		try {
			msg = JSON.parse(data.toString());
		} catch (error) {
			this.logger.error({ error }, "🔥 Error parsing Gemini message");
			return;
		}

		try {
			if (msg.setupComplete) {
				this.logger.info("✅ Gemini setup complete");
				this.setupComplete = true;
				if (this.pendingGreeting) {
					const text = this.pendingGreeting;
					this.pendingGreeting = null;
					this.send({
						clientContent: {
							turns: [
								{
									role: "user",
									parts: [{ text: `[Call connected — system note] ${text}` }],
								},
							],
							turnComplete: true,
						},
					});
				}
				return;
			}

			if (msg.serverContent) {
				const sc = msg.serverContent;

				if (sc.inputTranscription?.text) {
					this.patientTranscript += sc.inputTranscription.text;
				}

				if (sc.interrupted) {
					this.downsampler.reset();
					this.flushAiTranscript();
					this.handlers.onSpeechStarted();
				}

				for (const part of sc.modelTurn?.parts ?? []) {
					const audio = part.inlineData?.data;
					if (!audio) continue;
					this.flushPatientTranscript();
					const mulaw = this.downsampler.convert(audio);
					if (mulaw) this.handlers.onAudio(mulaw);
				}

				if (sc.outputTranscription?.text) {
					this.flushPatientTranscript();
					this.aiTranscript += sc.outputTranscription.text;
					this.handlers.onAiTranscriptDelta(sc.outputTranscription.text);
				}

				if (sc.turnComplete) {
					this.flushPatientTranscript();
					this.flushAiTranscript();
					this.handlers.onResponseDone();
				}
				return;
			}

			if (msg.toolCall) {
				this.flushPatientTranscript();
				for (const fc of msg.toolCall.functionCalls ?? []) {
					this.handlers.onFunctionCall({
						callId: fc.id,
						name: fc.name,
						args: JSON.stringify(fc.args ?? {}),
					});
				}
				return;
			}

			if (msg.toolCallCancellation) {
				this.logger.info(
					{ ids: msg.toolCallCancellation.ids },
					"↩️ Gemini cancelled tool calls",
				);
				return;
			}

			if (msg.goAway) {
				this.logger.warn(
					{ timeLeft: msg.goAway.timeLeft },
					"⏳ Gemini session ending soon (goAway)",
				);
				return;
			}

			if (msg.usageMetadata) {
				this.logger.debug({ usage: msg.usageMetadata }, "📊 Gemini usage");
			}
		} catch (error) {
			this.logger.error({ error }, "🔥 Error processing Gemini message");
		}
	}
}
