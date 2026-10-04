import type { SystemMessageTool } from "../types/index.js";

/**
 * Provider-agnostic contract between `TwilioSession` and a speech-to-speech
 * model (OpenAI Realtime, Gemini Live). All audio crossing this boundary is
 * base64 G.711 μ-law @ 8 kHz — the format Twilio and the dashboard use — so
 * providers own any resampling.
 */

export type RealtimeFunctionCall = {
	callId: string;
	name: string;
	/** JSON-encoded arguments object */
	args: string;
};

export type RealtimeHandlers = {
	/** Connection is open; `start()` may be called. */
	onReady(): void;
	onAudio(mulawBase64: string, itemId?: string): void;
	onAiTranscriptDelta(delta: string): void;
	onAiTranscriptDone(text: string): void;
	onPatientTranscript(text: string): void;
	/** Caller started talking (barge-in): stop playback. */
	onSpeechStarted(): void;
	onFunctionCall(call: RealtimeFunctionCall): void;
	/** The model finished a response turn. */
	onResponseDone(): void;
	onError(message: string, detail?: unknown): void;
	onClose(): void;
};

export type RealtimeSessionConfig = {
	instructions: string;
	tools: SystemMessageTool[];
	/** Caller's current language — lets providers pick a matching voice/locale. */
	language?: "en" | "fr" | "ar";
};

export interface RealtimeProvider {
	readonly name: string;
	connect(): Promise<void>;
	/** Configure the session and speak the opening greeting. Call exactly once. */
	start(config: RealtimeSessionConfig, greetingInstructions: string): void;
	/** Refresh instructions mid-call (best effort — not every provider supports it). */
	updateSession(config: RealtimeSessionConfig): void;
	/** Caller audio (μ-law 8 kHz, base64). Dropped until `start()` has run. */
	sendAudio(mulawBase64: string): void;
	/** Tell the model how much of an interrupted reply the caller actually heard. */
	truncate(itemId: string, audioEndMs: number): void;
	sendFunctionResult(call: RealtimeFunctionCall, output: string): void;
	/** Stop reacting to caller speech (goodbye is playing, hangup pending). */
	enterClosingMode(): void;
	close(): void;
}
