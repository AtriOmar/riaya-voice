import Redis from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";

/**
 * Per-call model choices made on the web /test-call page. The web app writes
 * them to Redis under `call-settings:<callSid>`; a call reads them once when it
 * starts. Only simulated calls (`CA_SIM*` sids) are ever looked up, so real
 * Twilio calls always use `.env`. Everything is optional: a missing field falls
 * back to the `.env` value. Keep this shape identical to the web schema in
 * `web/src/lib/call-settings.ts`.
 */

const reasoning = z.enum(["none", "minimal"]);

export const callSettingsSchema = z.object({
	pipeline: z
		.object({
			stt: z
				.object({
					api: z.enum([
						"openrouter-chat",
						"openrouter-transcription",
						"google",
						"openai",
						"livekit-inference",
						"inworld",
					]),
					model: z.string().min(1),
					reasoning: reasoning.optional(),
				})
				.optional(),
			llm: z
				.object({
					provider: z.enum(["openrouter", "google", "livekit-inference"]),
					model: z.string().min(1),
				})
				.optional(),
			tts: z
				.object({
					provider: z.enum([
						"gemini-openrouter",
						"gemini-google",
						"openai",
						"openrouter",
						"inworld",
						"inference",
					]),
					model: z.string().min(1),
					voice: z.string().optional(),
				})
				.optional(),
		})
		.optional(),
	phone: z
		.object({
			realtime: z
				.object({
					backend: z.enum(["gemini", "openai", "gpt-live"]),
					model: z.string().min(1),
					voice: z.string().optional(),
				})
				.optional(),
			callerStt: z
				.object({
					api: z.enum(["off", "openrouter-chat", "openrouter-transcription"]),
					model: z.string().optional(),
					reasoning: reasoning.optional(),
				})
				.optional(),
		})
		.optional(),
});

export type CallSettings = z.infer<typeof callSettingsSchema>;

const KEY_PREFIX = "call-settings:";
const READ_TIMEOUT_MS = 1500;

let client: Redis | null = null;
function redis(): Redis {
	client ??= new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
		maxRetriesPerRequest: 1,
	});
	client.on("error", () => {
		// Connection problems must never break a call; loads just return null.
	});
	return client;
}

/** Settings chosen on the test-call page for this call, or null (use `.env`). Never throws. */
export async function loadCallSettings(
	callSid: string | null | undefined,
	logger?: Logger,
): Promise<CallSettings | null> {
	if (!callSid?.startsWith("CA_SIM")) return null;
	try {
		const raw = await Promise.race([
			redis().get(`${KEY_PREFIX}${callSid}`),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), READ_TIMEOUT_MS),
			),
		]);
		if (!raw) return null;
		const parsed = callSettingsSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			logger?.warn(
				{ callSid, issues: parsed.error.issues.length },
				"Ignoring invalid call settings",
			);
			return null;
		}
		logger?.info(
			{ callSid, settings: parsed.data },
			"⚙️ Per-call settings loaded",
		);
		return parsed.data;
	} catch (error) {
		logger?.warn(
			{ error, callSid },
			"Could not load call settings (using .env)",
		);
		return null;
	}
}
