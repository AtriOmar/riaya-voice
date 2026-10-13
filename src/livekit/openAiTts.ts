import * as openai from "@livekit/agents-plugin-openai";

/** OpenAI's own TTS API (set TTS_PROVIDER=openai). Delete this file to drop the path. */

export type OpenAiTtsOptions = {
	model: string;
	voice: string;
	instructions?: string;
};

type OpenAIVoice = NonNullable<
	ConstructorParameters<typeof openai.TTS>[0]
>["voice"];

export function createOpenAiTts(opts: OpenAiTtsOptions) {
	return new openai.TTS({
		apiKey: process.env.OPENAI_API_KEY,
		model: opts.model,
		voice: opts.voice as OpenAIVoice,
		instructions: opts.instructions,
	});
}
