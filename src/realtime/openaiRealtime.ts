import type { Logger } from "pino";
import { type RawData, WebSocket } from "ws";
import type {
	RealtimeFunctionCall,
	RealtimeHandlers,
	RealtimeProvider,
	RealtimeSessionConfig,
} from "./types.js";

const { OPENAI_API_KEY, OPENAI_MODEL } = process.env as Record<string, string>;

const AUDIO_FORMAT = { type: "audio/pcmu" } as const;
const VOICE = "ash";
const TRANSCRIPTION_PROMPT =
	"The audio may be in Tunisian Arabic (Tunisian Derja), English, or French — transcribe in whatever language the caller uses; do not translate to another language. " +
	"Context: patients calling Riaya, a healthcare platform in Tunisia, to book doctor appointments by phone. " +
	"Expect symptoms and reasons for visit; medical speciality names; Tunisian city and neighborhood names; doctor and clinic (cabinet) names; " +
	"dates and times patients mention (often Tunisia local time, GMT+1); booking and confirmation phrases; phone numbers and people's names.";

function turnDetection(extra: Record<string, unknown> = {}) {
	return {
		type: "server_vad",
		threshold: parseFloat(process.env.VAD_THRESHOLD || "0.5"),
		silence_duration_ms: parseInt(process.env.SILENCE_DURATION_MS || "600", 10),
		...extra,
	};
}

function sessionAudio(turn: Record<string, unknown>, voice: string) {
	return {
		input: {
			format: AUDIO_FORMAT,
			transcription: {
				model:
					process.env.INPUT_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-transcribe",
				prompt: TRANSCRIPTION_PROMPT,
			},
			turn_detection: turn,
		},
		output: { format: AUDIO_FORMAT, voice },
	};
}

const EVENTS = {
	SessionCreated: "session.created",
	SessionUpdated: "session.updated",
	InputAudioBufferSpeechStarted: "input_audio_buffer.speech_started",
	ResponseOutputAudioDelta: "response.output_audio.delta",
	ResponseOutputAudioTranscriptDelta: "response.output_audio_transcript.delta",
	ResponseOutputAudioTranscriptDone: "response.output_audio_transcript.done",
	ResponseOutputItemDone: "response.output_item.done",
	ResponseDone: "response.done",
	Error: "error",
	ConversationItemInputAudioTranscriptionCompleted:
		"conversation.item.input_audio_transcription.completed",
	ConversationItemInputAudioTranscriptionFailed:
		"conversation.item.input_audio_transcription.failed",
	RateLimitsUpdated: "rate_limits.updated",
};

export type OpenAIRealtimeOptions = { model?: string; voice?: string };

/** OpenAI Realtime API, GA interface, G.711 μ-law passthrough. */
export class OpenAIRealtimeProvider implements RealtimeProvider {
	readonly name = "openai";
	private ws: WebSocket | null = null;
	private started = false;
	private pendingGreeting: string | null = null;

	private readonly model: string;
	private readonly voice: string;

	constructor(
		private readonly logger: Logger,
		private readonly handlers: RealtimeHandlers,
		opts: OpenAIRealtimeOptions = {},
	) {
		this.model = opts.model ?? (OPENAI_MODEL?.trim() || "gpt-realtime-mini");
		this.voice = opts.voice ?? VOICE;
	}

	connect(): Promise<void> {
		if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
		const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;
		this.logger.info(`🔌 Connecting to OpenAI at ${url}`);

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url, {
				headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
			});
			this.ws = ws;

			ws.on("open", () => {
				this.logger.info("🟢 OpenAI WebSocket connected");
				resolve();
			});
			ws.on("error", (error) => {
				this.logger.error({ error }, "🔥 OpenAI WebSocket error");
				reject(error);
			});
			ws.on("message", (data: RawData) => this.handleMessage(data));
			ws.on("close", () => {
				this.logger.info("🔴 OpenAI WebSocket closed");
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
				output_modalities: ["audio"],
				instructions: config.instructions,
				tools: config.tools,
				tool_choice: "auto",
				max_output_tokens: parseInt(
					process.env.MAX_OUTPUT_TOKENS || "4096",
					10,
				),
				audio: sessionAudio(turnDetection(), this.voice),
			},
		});
		this.logger.info("✅ Session config sent to OpenAI");
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
		this.send({ type: "response.create" });
	}

	prompt(instructions: string) {
		if (!this.started) return;
		this.send({ type: "response.create", response: { instructions } });
	}

	enterClosingMode() {
		this.send({
			type: "session.update",
			session: {
				type: "realtime",
				audio: {
					input: {
						turn_detection: turnDetection({
							interrupt_response: false,
							create_response: false,
						}),
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

			// biome-ignore lint/suspicious/noExplicitAny: OpenAI event payloads
			const handlers: Record<string, (e: any) => void> = {
				[EVENTS.SessionCreated]: () => {
					this.logger.info("✅ OpenAI session created");
					this.handlers.onReady();
				},
				[EVENTS.SessionUpdated]: () => {
					this.logger.info("✅ Session config updated");
					if (this.pendingGreeting === null) return;
					const instructions = this.pendingGreeting;
					this.pendingGreeting = null;
					this.send({
						type: "response.create",
						response: { instructions },
					});
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
				[EVENTS.ResponseOutputItemDone]: (e) => {
					const item = e.item;
					if (item?.type !== "function_call") return;
					this.handlers.onFunctionCall({
						callId: item.call_id,
						name: item.name,
						args: item.arguments,
					});
				},
				[EVENTS.ResponseDone]: () => this.handlers.onResponseDone(),
				[EVENTS.Error]: (e) =>
					this.handlers.onError(e.error?.message || "OpenAI error", e.error),
				[EVENTS.RateLimitsUpdated]: (e) =>
					this.logger.info({ rateLimits: e.rate_limits }, "📊 Rate limits"),
			};

			handlers[event.type]?.(event);
		} catch (error) {
			this.logger.error({ error }, "🔥 Error processing OpenAI message");
		}
	}
}
