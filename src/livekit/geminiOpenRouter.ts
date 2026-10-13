import * as openai from "@livekit/agents-plugin-openai";
import { type GeminiSTTOptions, GeminiTranscribeSTT } from "./geminiStt.js";

/** Gemini through OpenRouter (set GEMINI_PROVIDER=openrouter). Delete this file to drop the path. */

const BASE_URL = "https://openrouter.ai/api/v1";

type OpenAIVoice = NonNullable<
	ConstructorParameters<typeof openai.TTS>[0]
>["voice"];

export function createOpenRouterGeminiStt(opts: GeminiSTTOptions) {
	return new GeminiTranscribeSTT(opts);
}

export function createOpenRouterGeminiLlm(model: string) {
	return new openai.LLM({
		model,
		baseURL: BASE_URL,
		apiKey: process.env.OPENROUTER_API_KEY,
	});
}

export function createOpenRouterGeminiTts(model: string, voice: string) {
	return new openai.TTS({
		baseURL: BASE_URL,
		apiKey: process.env.OPENROUTER_API_KEY,
		model,
		voice: voice as OpenAIVoice,
	});
}
