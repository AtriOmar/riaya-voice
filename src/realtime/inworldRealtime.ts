import type { Logger } from "pino";
import { type RawData, WebSocket } from "ws";
import type {
	RealtimeFunctionCall,
	RealtimeHandlers,
	RealtimeProvider,
	RealtimeSessionConfig,
} from "./types.js";

const INWORLD_API_KEY = process.env.INWORLD_API_KEY;
/** `provider/model`, e.g. `google-ai-studio/gemini-3.8-flash`, `anthropic/claude-sonnet-4-6`. */
const INWORLD_MODEL =
	process.env.INWORLD_MODEL?.trim() || "google-ai-studio/gemini-3.1-flash-lite";
const INWORLD_VOICE = process.env.INWORLD_VOICE?.trim() || "Nour";
const INWORLD_TTS_MODEL =
	process.env.INWORLD_TTS_MODEL?.trim() || "inworld-tts-2";

const LIVE_URL = "wss://api.inworld.ai/api/v1/realtime/session";

/** Synthesis language per caller language (Tunisian Arabic is `aeb`). */
const TTS_LANGUAGE = { ar: "aeb", fr: "fr-FR", en: "en-US" } as const;

/** Vocabulary hints for Inworld STT (it takes phrases, not a free-text prompt). */
const STT_PROMPTS = [
	"Riaya",
	"rendez-vous",
	"cardiologue",
	"dermatologue",
	"pédiatre",
	"gynécologue",
	"dentiste",
	"Tunis",
	"Sfax",
	"Sousse",
	"Ariana",
	"Ben Arous",
	"La Marsa",
	"Menzah",
	"Nabeul",
	"Monastir",
	"Bizerte",
];

const EVENTS = {
	SessionCreated: "session.created",
	SessionUpdated: "session.updated",
	InputAudioBufferSpeechStarted: "input_audio_buffer.speech_started",
	ResponseOutputAudioDelta: "response.output_audio.delta",
	ResponseOutputAudioTranscriptDelta: "response.output_audio_transcript.delta",
	ResponseOutputAudioTranscriptDone: "response.output_audio_transcript.done",
	ResponseFunctionCallArgumentsDone: "response.function_call_arguments.done",
	ResponseDone: "response.done",
	Error: "error",
	ConversationItemInputAudioTranscriptionCompleted:
		"conversation.item.input_audio_transcription.completed",
	ConversationItemInputAudioTranscriptionFailed:
		"conversation.item.input_audio_transcription.failed",
};

/**
 * Inworld Realtime API: OpenAI Realtime GA protocol in front of a pipeline
 * (Inworld STT → any routed LLM → Inworld TTS). Audio stays G.711 μ-law end to
 * end, and Inworld continues the turn on its own after a tool result
 * (`auto_tool_response`), so no `response.create` follows tool output.
 */
export class InworldRealtimeProvider implements RealtimeProvider {
	readonly name = "inworld";
	private ws: WebSocket | null = null;
	private started = false;
	private pendingGreeting: string | null = null;

	constructor(
		private readonly logger: Logger,
		private readonly handlers: RealtimeHandlers,
	) {}

	connect(): Promise<void> {
		if (!INWORLD_API_KEY) throw new Error("INWORLD_API_KEY is not set");
		this.logger.info(`🔌 Connecting to Inworld Realtime (${INWORLD_MODEL})`);
		const sessionKey = `riaya-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(
				`${LIVE_URL}?key=${sessionKey}&protocol=realtime`,
				{ headers: { Authorization: `Basic ${INWORLD_API_KEY}` } },
			);
			this.ws = ws;

			ws.on("open", () => {
				this.logger.info("🟢 Inworld WebSocket connected");
				resolve();
			});
			ws.on("error", (error) => {
				this.logger.error({ error }, "🔥 Inworld WebSocket error");
				reject(error);
			});
			ws.on("message", (data: RawData) => this.handleMessage(data));
			ws.on("close", (code, reason) => {
				const why = reason.toString();
				this.logger.info({ code, reason: why }, "🔴 Inworld WebSocket closed");
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
		// Greeting goes out once the server acknowledges the config (session.updated).
		this.pendingGreeting = greetingInstructions;
		this.updateSession(config);
	}

	updateSession(config: RealtimeSessionConfig) {
		this.send({
			type: "session.update",
			session: {
				type: "realtime",
				model: INWORLD_MODEL,
				instructions: config.instructions,
				output_modalities: ["audio"],
				tools: config.tools,
				tool_choice: "auto",
				audio: {
					input: {
						format: { type: "audio/pcmu" },
						transcription: {
							model: "inworld/inworld-stt-1",
							prompts: STT_PROMPTS,
						},
						turn_detection: {
							type: "semantic_vad",
							eagerness: "medium",
							create_response: true,
							interrupt_response: true,
						},
					},
					output: {
						format: { type: "audio/pcmu" },
						model: INWORLD_TTS_MODEL,
						voice: INWORLD_VOICE,
					},
				},
				providerData: {
					auto_tool_response: true,
					...(config.language
						? { tts: { language: TTS_LANGUAGE[config.language] } }
						: {}),
				},
			},
		});
		this.logger.info(
			{ language: config.language },
			"✅ Session config sent to Inworld",
		);
	}

	sendAudio(mulawBase64: string) {
		if (!this.started) return;
		this.send({ type: "input_audio_buffer.append", audio: mulawBase64 });
	}

	truncate(itemId: string, audioEndMs: number) {
		this.send({
			type: "conversation.item.truncate",
			item_id: itemId,
			content_index: 0,
			audio_end_ms: audioEndMs,
		});
	}

	sendFunctionResult(call: RealtimeFunctionCall, output: string) {
		this.send({
			type: "conversation.item.create",
			item: { type: "function_call_output", call_id: call.callId, output },
		});
	}

	enterClosingMode() {
		this.send({
			type: "session.update",
			session: {
				type: "realtime",
				audio: {
					input: {
						turn_detection: {
							type: "semantic_vad",
							eagerness: "medium",
							create_response: false,
							interrupt_response: false,
						},
					},
				},
			},
		});
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

	private handleMessage(data: RawData) {
		try {
			const event = JSON.parse(data.toString());
			if (event.type !== EVENTS.ResponseOutputAudioDelta) {
				this.logger.debug({ type: event.type }, "Inworld event");
			}

			// biome-ignore lint/suspicious/noExplicitAny: Inworld/OpenAI event payloads
			const handlers: Record<string, (e: any) => void> = {
				[EVENTS.SessionCreated]: () => {
					this.logger.info("✅ Inworld session created");
					this.handlers.onReady();
				},
				[EVENTS.SessionUpdated]: () => {
					this.logger.info("✅ Session config updated");
					if (this.pendingGreeting === null) return;
					const instructions = this.pendingGreeting;
					this.pendingGreeting = null;
					this.send({ type: "response.create", response: { instructions } });
				},
				[EVENTS.ResponseOutputAudioDelta]: (e) => {
					if (e.delta) this.handlers.onAudio(e.delta, e.item_id);
				},
				[EVENTS.ResponseOutputAudioTranscriptDelta]: (e) => {
					if (e.delta) this.handlers.onAiTranscriptDelta(e.delta);
				},
				[EVENTS.ResponseOutputAudioTranscriptDone]: (e) =>
					this.handlers.onAiTranscriptDone(e.transcript ?? ""),
				[EVENTS.InputAudioBufferSpeechStarted]: () =>
					this.handlers.onSpeechStarted(),
				[EVENTS.ConversationItemInputAudioTranscriptionCompleted]: (e) => {
					if (e.transcript) this.handlers.onPatientTranscript(e.transcript);
				},
				[EVENTS.ConversationItemInputAudioTranscriptionFailed]: (e) =>
					this.logger.error({ error: e.error }, "🔥 Transcription failed"),
				[EVENTS.ResponseFunctionCallArgumentsDone]: (e) =>
					this.handlers.onFunctionCall({
						callId: e.call_id,
						name: e.name,
						args: e.arguments,
					}),
				[EVENTS.ResponseDone]: () => this.handlers.onResponseDone(),
				[EVENTS.Error]: (e) =>
					this.handlers.onError(e.error?.message || "Inworld error", e.error),
			};

			handlers[event.type]?.(event);
		} catch (error) {
			this.logger.error({ error }, "🔥 Error processing Inworld message");
		}
	}
}
