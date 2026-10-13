import type { Logger } from "pino";
import { type RawData, WebSocket } from "ws";
import {
	type CallLanguage,
	LANGUAGE_LABEL,
} from "../sessions/callInstructions.js";
import type {
	RealtimeFunctionCall,
	RealtimeHandlers,
	RealtimeProvider,
	RealtimeSessionConfig,
} from "./types.js";

/**
 * OpenAI GPT-Live (`/v1/live/sessions`): one full-duplex voice model that
 * listens, takes turns and speaks. Tool calls and reasoning are delegated to a
 * backend Responses model; its function calls come back as `response.event`s.
 *
 * Unlike the other providers, GPT-Live has no speech-started / response-done
 * events and streams audio continuously (digital silence between replies, and
 * its clock only advances while caller audio keeps arriving). So this provider
 * derives "a reply started/ended" from the level of the output audio, and
 * "the caller is talking" from the caller transcript deltas.
 */

const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
const DEFAULT_MODEL = "gpt-live-1";
const DEFAULT_VOICE = "marin";
const DEFAULT_BACKEND_MODEL = "gpt-5.6-luna";

/**
 * Added to the voice model's instructions only. Left alone, the voice model
 * answers goodbyes itself, so the backend never calls `end_call` and the phone
 * line is never hung up.
 */
const VOICE_ROLE_NOTE = `

## YOUR ROLE AS THE VOICE
You are the voice of this assistant. A backend assistant decides what to do and runs the tools; you speak for it.
- Never end or wrap up the conversation yourself and never say goodbye on your own initiative.
- Whenever the caller says goodbye, says thanks and that they need nothing else, or the conversation is finished, hand it to the backend so it can call \`end_call\`. Only after that do you say a brief goodbye.`;

/** Twilio's G.711 μ-law @ 8 kHz is accepted natively, so audio passes through. */
const AUDIO_FORMAT = { type: "audio/pcmu", rate: 8000 } as const;
const MULAW_BYTES_PER_MS = 8;

/** Same silence floor the LiveKit plugin uses (6e-4), with its 3x / 1.8x ratios. */
const GATE_OPEN_RMS = 1.8e-3;
const GATE_HOLD_RMS = 1.08e-3;
/** A reply is over after this much quiet, so short pauses inside it don't split it. */
const GATE_HANGOVER_MS = 800;
/**
 * After a turn that involved the backend (tool calls), the voice often speaks a
 * filler, then the real answer 0.5-0.9 s after the backend finishes. "Reply
 * done" waits this long after the backend is idle so a filler isn't mistaken
 * for the final goodbye.
 */
const SETTLE_MS = Number.parseInt(process.env.GPT_LIVE_SETTLE_MS || "1500", 10);
/** A caller utterance is over after this long without new transcript text. */
const USER_TURN_GAP_MS = 800;

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

/** Normalized (0..1) RMS level of a μ-law buffer. */
function mulawRms(buf: Buffer): number {
	if (buf.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < buf.length; i++) {
		const s = ULAW_TO_LINEAR[buf[i]];
		sum += s * s;
	}
	return Math.sqrt(sum / buf.length) / 32768;
}

type ResponsesEvent = {
	type: string;
	response?: { error?: unknown; incomplete_details?: unknown } | null;
	item?: {
		type?: string | null;
		call_id?: string | null;
		name?: string | null;
		arguments?: string | null;
	} | null;
};

type ServerEvent = {
	type: string;
	delta?: string;
	delegation_id?: string | null;
	event?: ResponsesEvent;
	error?: { message?: string; code?: string; type?: string };
	reason?: string | null;
};

export type GptLiveOptions = { model?: string; voice?: string };

export class GptLiveProvider implements RealtimeProvider {
	readonly name = "gpt-live";
	private ws: WebSocket | null = null;
	private started = false;
	private sessionLive = false;
	private closeNotified = false;
	private eventSeq = 0;
	private pendingGreeting: string | null = null;
	private queued: Record<string, unknown>[] = [];

	private language: CallLanguage | undefined;
	private firstName: string | null | undefined;

	private gateOpen = false;
	private gateQuietMs = 0;
	private aiText = "";
	private backendTouched = false;
	private finishPending = false;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;

	private userText = "";
	private userTimer: ReturnType<typeof setTimeout> | null = null;

	// Backend (Responses) function-call bookkeeping: GPT-Live needs the
	// outputs of every call of a response, then one `response.create`.
	private running = new Map<string | null, Set<string>>();
	private openCalls = new Set<string>();
	private responsePending = false;

	constructor(
		private readonly logger: Logger,
		private readonly handlers: RealtimeHandlers,
		private readonly opts: GptLiveOptions = {},
	) {}

	connect(): Promise<void> {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) return Promise.reject(new Error("OPENAI_API_KEY is not set"));
		this.logger.info(`🔌 Connecting to GPT-Live at ${LIVE_URL}`);

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(LIVE_URL, {
				headers: { Authorization: `Bearer ${apiKey}` },
			});
			this.ws = ws;

			ws.on("open", () => {
				this.logger.info("🟢 GPT-Live WebSocket connected");
				this.handlers.onReady();
				resolve();
			});
			ws.on("error", (error) => {
				this.logger.error({ error }, "🔥 GPT-Live WebSocket error");
				reject(error);
			});
			ws.on("message", (data: RawData) => this.handleMessage(data));
			ws.on("close", () => {
				this.logger.info("🔴 GPT-Live WebSocket closed");
				this.notifyClosed();
			});
		});
	}

	start(config: RealtimeSessionConfig, greetingInstructions: string) {
		if (this.started) return;
		this.started = true;
		this.language = config.language;
		this.firstName = config.firstName;
		this.pendingGreeting = greetingInstructions;

		// The voice persona and the backend model get the same prompt: the
		// backend decides what to ask, call and answer; the voice speaks it.
		this.send({
			type: "session.start",
			event_id: this.eventId("start"),
			session: {
				model:
					this.opts.model ||
					process.env.GPT_LIVE_MODEL?.trim() ||
					DEFAULT_MODEL,
				instructions: config.instructions + VOICE_ROLE_NOTE,
				audio: {
					format: AUDIO_FORMAT,
					output: {
						voice:
							this.opts.voice ||
							process.env.GPT_LIVE_VOICE?.trim() ||
							DEFAULT_VOICE,
					},
				},
				delegation: {
					type: "responses",
					responses: {
						model:
							process.env.GPT_LIVE_BACKEND_MODEL?.trim() ||
							DEFAULT_BACKEND_MODEL,
						instructions: config.instructions,
						tools: config.tools.length > 0 ? config.tools : undefined,
					},
				},
			},
		});
		this.logger.info("✅ Session start sent to GPT-Live");
	}

	updateSession(config: RealtimeSessionConfig) {
		if (!this.started) return;
		// Voice instructions are immutable after start; only short standing
		// rules can be appended. The backend prompt can be replaced whole.
		const notes: string[] = [];
		if (config.firstName && config.firstName !== this.firstName) {
			notes.push(`The caller's first name is ${config.firstName}.`);
		}
		if (config.language && config.language !== this.language) {
			const label = LANGUAGE_LABEL[config.language];
			notes.push(
				`The caller asked to speak ${label}. Reply only in ${label} from now on.`,
			);
		}
		this.language = config.language;
		this.firstName = config.firstName;

		this.sendWhenLive({
			type: "session.update",
			event_id: this.eventId("update"),
			session: {
				delegation: {
					type: "responses",
					responses: { instructions: config.instructions },
				},
			},
		});
		for (const note of notes) {
			this.sendWhenLive({
				type: "session.instructions.append",
				event_id: this.eventId("append"),
				delegation_id: null,
				content: note,
			});
		}
	}

	sendAudio(mulawBase64: string) {
		// Must keep flowing for the whole call (even while muted), because the
		// model only advances — and speaks — as caller audio arrives.
		if (!this.sessionLive) return;
		this.send({ type: "session.input_audio.append", audio: mulawBase64 });
	}

	truncate(_itemId: string, _audioEndMs: number) {
		// Full-duplex: the model manages its own interruptions; no item ids.
	}

	sendFunctionResult(call: RealtimeFunctionCall, output: string) {
		this.sendWhenLive({
			type: "response.item.create",
			event_id: this.eventId("tool_output"),
			item: {
				type: "function_call_output",
				call_id: call.callId,
				output,
			},
		});
		this.openCalls.delete(call.callId);
		for (const calls of this.running.values()) calls.delete(call.callId);
		this.responsePending = true;
		this.maybeContinue();
		this.evaluateFinish();
	}

	enterClosingMode() {
		// Server replaces caller audio with silence, so the goodbye can't be
		// talked over. Audio must still be streamed so the model keeps speaking.
		this.sendWhenLive({
			type: "session.input_audio.mute",
			event_id: this.eventId("mute"),
		});
	}

	close() {
		if (this.userTimer) clearTimeout(this.userTimer);
		this.userTimer = null;
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = null;
		const ws = this.ws;
		if (!ws) return;
		ws.removeAllListeners();
		ws.on("error", () => {});
		if (ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "session.close" }));
			} catch {
				// socket already going away
			}
		}
		if (
			ws.readyState !== WebSocket.CLOSED &&
			ws.readyState !== WebSocket.CLOSING
		) {
			ws.close();
		}
	}

	// ==================== Outgoing ====================

	private eventId(prefix: string) {
		return `${prefix}_${++this.eventSeq}`;
	}

	private send(payload: Record<string, unknown>) {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(payload));
	}

	/** Commands are only accepted once `session.started` has arrived. */
	private sendWhenLive(payload: Record<string, unknown>) {
		if (this.sessionLive) this.send(payload);
		else this.queued.push(payload);
	}

	private maybeContinue() {
		if (this.running.size > 0 || this.openCalls.size > 0) return;
		if (!this.responsePending) {
			this.logger.debug("🧠 GPT-Live backend idle");
			return;
		}
		this.responsePending = false;
		this.send({ type: "response.create", event_id: this.eventId("respond") });
	}

	// ==================== Incoming ====================

	private notifyClosed() {
		if (this.closeNotified) return;
		this.closeNotified = true;
		this.handlers.onClose();
	}

	private handleMessage(data: RawData) {
		let event: ServerEvent;
		try {
			event = JSON.parse(data.toString());
		} catch (error) {
			this.logger.error({ error }, "🔥 Unparseable GPT-Live message");
			return;
		}

		try {
			switch (event.type) {
				case "session.started":
					this.onSessionStarted();
					break;
				case "session.output_audio.delta":
					this.onOutputAudio(event.delta ?? "");
					break;
				case "session.output_transcript.delta":
					if (event.delta) {
						this.aiText += event.delta;
						this.handlers.onAiTranscriptDelta(event.delta);
					}
					break;
				case "session.input_transcript.delta":
					if (event.delta) this.onCallerTranscript(event.delta);
					break;
				case "response.event":
					this.onResponseEvent(event.delegation_id ?? null, event.event);
					break;
				case "error":
					this.handlers.onError(
						event.error?.message || "GPT-Live error",
						event.error,
					);
					break;
				case "session.closed":
					this.logger.info({ reason: event.reason }, "🔴 GPT-Live closed");
					this.notifyClosed();
					break;
				case "session.usage.updated":
					break;
				default:
					this.logger.debug({ type: event.type }, "GPT-Live event");
			}
		} catch (error) {
			this.logger.error({ error }, "🔥 Error processing GPT-Live message");
		}
	}

	private onSessionStarted() {
		if (this.sessionLive) return;
		this.sessionLive = true;
		this.logger.info("✅ GPT-Live session started");

		const queued = this.queued;
		this.queued = [];
		for (const payload of queued) this.send(payload);

		if (this.pendingGreeting !== null) {
			const instructions = this.pendingGreeting;
			this.pendingGreeting = null;
			this.send({
				type: "session.commentary.append",
				event_id: this.eventId("greeting"),
				delegation_id: null,
				content: `Immediately follow the instruction below. Do not wait for the caller to speak first. After that, pause and listen.\n\n${instructions}`,
			});
		}
	}

	/** Gate the continuous output stream into discrete replies. */
	private onOutputAudio(deltaBase64: string) {
		if (!deltaBase64) return;
		const audio = Buffer.from(deltaBase64, "base64");
		if (audio.length === 0) return;
		const level = mulawRms(audio);
		const wasOpen = this.gateOpen;

		if (!this.gateOpen) {
			if (level > GATE_OPEN_RMS) {
				this.gateOpen = true;
				this.gateQuietMs = 0;
				this.logger.debug("🔊 GPT-Live reply audio started");
				this.evaluateFinish();
			}
		} else if (level < GATE_HOLD_RMS) {
			this.gateQuietMs += audio.length / MULAW_BYTES_PER_MS;
			if (this.gateQuietMs >= GATE_HANGOVER_MS) this.gateOpen = false;
		} else {
			this.gateQuietMs = 0;
		}

		if (this.gateOpen || wasOpen) this.handlers.onAudio(deltaBase64);
		if (wasOpen && !this.gateOpen) this.onGateClosed();
	}

	private onGateClosed() {
		this.logger.debug("🔇 GPT-Live reply audio ended");
		// The voice model writes expressive tags ("[laugh]", "[tongue click]")
		// into its transcript; they are not words, so keep them out of the logs.
		const text = this.aiText
			.replace(/\[[^\]]{1,40}\]/g, "")
			.replace(/\s{2,}/g, " ")
			.trim();
		this.aiText = "";
		if (text) this.handlers.onAiTranscriptDone(text);

		if (!this.backendTouched) {
			this.handlers.onResponseDone();
			return;
		}
		this.finishPending = true;
		this.evaluateFinish();
	}

	private backendIdle() {
		return (
			this.running.size === 0 &&
			this.openCalls.size === 0 &&
			!this.responsePending
		);
	}

	/** Signal "reply done" once the voice is quiet and the backend stayed idle. */
	private evaluateFinish() {
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = null;
		if (!this.finishPending || this.gateOpen || !this.backendIdle()) return;
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			if (!this.finishPending || this.gateOpen || !this.backendIdle()) return;
			this.finishPending = false;
			this.backendTouched = false;
			this.handlers.onResponseDone();
		}, SETTLE_MS);
	}

	/** Assemble caller transcript deltas into utterances; first delta = barge-in. */
	private onCallerTranscript(delta: string) {
		if (this.userText === "" && this.gateOpen) this.handlers.onSpeechStarted();
		this.userText += delta;
		if (this.userTimer) clearTimeout(this.userTimer);
		this.userTimer = setTimeout(
			() => this.flushCallerUtterance(),
			USER_TURN_GAP_MS,
		);
	}

	private flushCallerUtterance() {
		this.userTimer = null;
		const text = this.userText.trim();
		this.userText = "";
		if (text) this.handlers.onPatientTranscript(text);
	}

	private onResponseEvent(
		delegationId: string | null,
		event: ResponsesEvent | undefined,
	) {
		if (!event) return;
		switch (event.type) {
			case "response.created":
				this.running.set(delegationId, new Set());
				this.backendTouched = true;
				this.evaluateFinish();
				break;
			case "response.output_item.done": {
				const item = event.item;
				if (item?.type !== "function_call") return;
				if (!item.call_id || !item.name || item.arguments == null) {
					this.logger.warn(
						{ callId: item.call_id, name: item.name },
						"GPT-Live dropping function call with missing fields",
					);
					return;
				}
				(this.running.get(delegationId) ?? this.openCalls).add(item.call_id);
				this.handlers.onFunctionCall({
					callId: item.call_id,
					name: item.name,
					args: item.arguments,
				});
				break;
			}
			case "response.completed": {
				const calls = this.running.get(delegationId);
				if (calls) {
					this.running.delete(delegationId);
					for (const id of calls) this.openCalls.add(id);
				}
				this.maybeContinue();
				this.evaluateFinish();
				break;
			}
			case "response.failed":
			case "response.incomplete":
				this.logger.warn(
					{ type: event.type, delegationId, detail: event.response },
					"GPT-Live backend response did not complete",
				);
				this.running.delete(delegationId);
				this.maybeContinue();
				this.evaluateFinish();
				break;
		}
	}
}
