import type { Logger } from "pino";
import { GeminiLiveProvider } from "./geminiLive.js";
import { GptLiveProvider } from "./gptLive.js";
import { InworldRealtimeProvider } from "./inworldRealtime.js";
import { OpenAIRealtimeProvider } from "./openaiRealtime.js";
import type { RealtimeHandlers, RealtimeProvider } from "./types.js";

export type { RealtimeFunctionCall, RealtimeProvider } from "./types.js";

/** Per-call override from the test-call page; each field falls back to `.env`. */
export type RealtimeOverride = {
	backend?: string;
	model?: string;
	voice?: string;
};

/** `BACKEND=gemini` (default), `inworld`, `openai` or `gpt-live`. */
export function createRealtimeProvider(
	logger: Logger,
	handlers: RealtimeHandlers,
	override: RealtimeOverride = {},
): RealtimeProvider {
	const backend =
		override.backend ?? (process.env.BACKEND?.trim().toLowerCase() || "gemini");
	const options = { model: override.model, voice: override.voice };
	if (backend === "gpt-live")
		return new GptLiveProvider(logger, handlers, options);
	if (backend === "openai")
		return new OpenAIRealtimeProvider(logger, handlers, options);
	if (backend === "inworld")
		return new InworldRealtimeProvider(logger, handlers);
	if (backend !== "gemini") {
		logger.warn({ backend }, "Unknown BACKEND, falling back to gemini");
	}
	return new GeminiLiveProvider(logger, handlers, options);
}
