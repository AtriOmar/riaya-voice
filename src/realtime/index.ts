import type { Logger } from "pino";
import { GeminiLiveProvider } from "./geminiLive.js";
import { GptLiveProvider } from "./gptLive.js";
import { InworldRealtimeProvider } from "./inworldRealtime.js";
import { OpenAIRealtimeProvider } from "./openaiRealtime.js";
import type { RealtimeHandlers, RealtimeProvider } from "./types.js";

export type { RealtimeFunctionCall, RealtimeProvider } from "./types.js";

/** `BACKEND=gemini` (default), `inworld`, `openai` or `gpt-live`. */
export function createRealtimeProvider(
	logger: Logger,
	handlers: RealtimeHandlers,
): RealtimeProvider {
	const backend = process.env.BACKEND?.trim().toLowerCase() || "gemini";
	if (backend === "gpt-live") return new GptLiveProvider(logger, handlers);
	if (backend === "openai") return new OpenAIRealtimeProvider(logger, handlers);
	if (backend === "inworld")
		return new InworldRealtimeProvider(logger, handlers);
	if (backend !== "gemini") {
		logger.warn({ backend }, "Unknown BACKEND, falling back to gemini");
	}
	return new GeminiLiveProvider(logger, handlers);
}
