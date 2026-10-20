import { fileURLToPath } from "node:url";
import {
	cli,
	defineAgent,
	inference,
	type JobContext,
	type JobProcess,
	type LanguageCode,
	llm,
	ServerOptions,
	voice,
} from "@livekit/agents";
import * as inworld from "@livekit/agents-plugin-inworld";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { ParticipantKind } from "@livekit/rtc-node";
import { pino } from "pino";
import {
	type CallerRefusalContext,
	getCallerRefusalContext,
} from "../api/callerAppointmentsApi.js";
import {
	getPeopleOnLine,
	ownerOnly,
	type PersonOnLine,
} from "../api/callerPeopleApi.js";
import { type CallerPlace, getCallerLastPlace } from "../api/callerPlaceApi.js";
import { createCallEvent, ensureCallRow, updateCall } from "../api/callsApi.js";
import { ensurePersonRow } from "../api/personsApi.js";
import { CITIES } from "../constants/cities.js";
import { SPECIALITIES } from "../constants/specialities.js";
import {
	buildCallInstructions,
	buildHangupToolResult,
	buildInitialGreetingInstructions,
	buildWatchdogInstructions,
	type CallLanguage,
	LANGUAGE_LABEL,
	normalizeCallLanguage,
	type WatchdogPrompt,
} from "../sessions/callInstructions.js";
import { CallWatchdog } from "../sessions/callWatchdog.js";
import { getSystemMessage } from "../sessions/systemMessages.js";
import {
	type CallSettings,
	loadCallSettings,
} from "../settings/callSettings.js";
import {
	CallTools,
	type PersonRow,
	toolFailureMessage,
} from "../tools/callTools.js";
import { DashboardRelay } from "./dashboardRelay.js";
import {
	createGoogleGeminiLlm,
	createGoogleGeminiStt,
	createGoogleGeminiTts,
	GoogleGeminiTranscribeSTT,
} from "./geminiGoogle.js";
import {
	createOpenRouterGeminiLlm,
	createOpenRouterGeminiStt,
	createOpenRouterGeminiTts,
} from "./geminiOpenRouter.js";
import { GeminiTranscribeSTT } from "./geminiStt.js";
import { MaiTranscribeSTT } from "./maiStt.js";
import { createOpenAiTts } from "./openAiTts.js";
import { OpenRouterTranscribeSTT } from "./openRouterTranscribeSTT.js";
import { extractProfile } from "./profileCapture.js";

/**
 * LiveKit voice agent: speech-to-text → LLM (+ booking tools) → text-to-speech,
 * each configurable from `.env` (STT_MODEL, OPENROUTER_MODEL, TTS_PROVIDER).
 * Runs as its own worker process (`pnpm agent:dev`), separate from the voice
 * server. Joins rooms created for Twilio SIP calls and for `/test-call` browser
 * calls. Must not import server.ts / WhatsApp / BullMQ workers.
 */

const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME?.trim() || "riaya-agent";
/**
 * `openrouter` (default), `livekit` (LiveKit Inference, billed to the LiveKit
 * project's credits) or `gpt-live` (OpenAI GPT-Live: one full-duplex model that
 * listens, takes turns and speaks itself, so STT_* and TTS_* are unused).
 */
const LLM_PROVIDER =
	process.env.LLM_PROVIDER?.trim().toLowerCase() || "openrouter";
const GPT_LIVE = LLM_PROVIDER === "gpt-live";
const GPT_LIVE_VOICE = process.env.GPT_LIVE_VOICE?.trim() || "marin";
/** Model GPT-Live hands tool calls and reasoning to; unset uses OpenAI's default. */
const GPT_LIVE_BACKEND_MODEL = process.env.GPT_LIVE_BACKEND_MODEL?.trim();
const OPENROUTER_MODEL =
	process.env.OPENROUTER_MODEL?.trim() || "openai/gpt-5.4-mini";
const LIVEKIT_LLM_MODEL =
	process.env.LIVEKIT_LLM_MODEL?.trim() || "openai/gpt-5.4-mini";
const INWORLD_VOICE = process.env.INWORLD_VOICE?.trim() || "Nour";
const INWORLD_TTS_MODEL =
	process.env.INWORLD_TTS_MODEL?.trim() || "inworld-tts-2";

/** `stt`: Inworld STT decides end of turn. `vad`: Silero silence + ENDPOINTING_MIN_DELAY_MS. */
const TURN_DETECTION =
	process.env.TURN_DETECTION?.trim().toLowerCase() === "vad" ? "vad" : "stt";
const ENDPOINTING_MIN_DELAY_MS = parseInt(
	process.env.ENDPOINTING_MIN_DELAY_MS || "500",
	10,
);
const END_CALL_MAX_WAIT_MS = parseInt(
	process.env.END_CALL_MAX_WAIT_MS || "12000",
	10,
);

/** Inworld TTS locales per caller language (Tunisian Arabic is `aeb`). */
const TTS_LANGUAGE: Record<CallLanguage, string> = {
	ar: "aeb",
	fr: "fr-FR",
	en: "en-US",
};

/**
 * Speech-to-text: `gemini` (a regular Gemini model transcribes each sentence,
 * prompted for Derja/French/English), `mai` (Microsoft MAI-Transcribe-2 via
 * OpenRouter, whole sentences, only ar/fr/en accepted), `inworld` (Inworld's own model) or any
 * LiveKit Inference model string, e.g. `xai/stt-2`,
 * `google/gemini-3.5-transcribe-live`, `cartesia/ink-whisper`, `deepgram/nova-3`.
 * Do not use `multi` as a language hint (returns nothing on xai); a per-call
 * hint is auto-corrected by the model.
 */
const STT_MODEL = process.env.STT_MODEL?.trim() || "mai";
/** Which API the Gemini models use: `openrouter` (default) or `google` (Gemini API, GEMINI_API_KEY). */
const GEMINI_PROVIDER =
	process.env.GEMINI_PROVIDER?.trim().toLowerCase() === "google"
		? "google"
		: "openrouter";
/** Gemini model used when STT_MODEL=gemini (audio in, transcript out, via OpenRouter). */
const GEMINI_STT_MODEL =
	process.env.GEMINI_STT_MODEL?.trim() || "google/gemini-3.8-flash";
const GOOGLE_STT_MODEL =
	process.env.GOOGLE_STT_MODEL?.trim() || "gemini-3.5-transcribe";
const OPENAI_TTS_MODEL =
	process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE?.trim() || "coral";
const OPENAI_TTS_INSTRUCTIONS = process.env.OPENAI_TTS_INSTRUCTIONS?.trim();
const OPENROUTER_WHISPER_MODEL =
	process.env.OPENROUTER_WHISPER_MODEL?.trim() ||
	"openai/whisper-large-v3-turbo";
const GEMINI_STT_REASONING =
	process.env.GEMINI_STT_REASONING?.trim() === "none" ? "none" : "minimal";
const GEMINI_LLM_MODEL =
	process.env.GEMINI_LLM_MODEL?.trim() || "google/gemini-2.5-flash";
const GOOGLE_LLM_MODEL =
	process.env.GOOGLE_LLM_MODEL?.trim() || "gemini-2.5-flash";
const GEMINI_OPENROUTER_TTS_MODEL =
	process.env.GEMINI_OPENROUTER_TTS_MODEL?.trim() ||
	"google/gemini-3.8-flash-lite-tts";
const GEMINI_OPENROUTER_TTS_VOICE =
	process.env.GEMINI_OPENROUTER_TTS_VOICE?.trim() || "Charon";
/**
 * `auto`: no language hint, the model detects the language itself. Needed for
 * Gemini, which drops French words in Derja sentences when given an `ar` hint.
 * `call`: pass the caller's language as a hint (Inworld STT, Deepgram, ...).
 */
const STT_LANGUAGE_HINT =
	process.env.STT_LANGUAGE_HINT?.trim().toLowerCase() === "call"
		? "call"
		: "auto";
/**
 * `background` (default): the conversation model has no `update_person_info`
 * tool; a small model captures name/language off the reply path (saves a ~1 s
 * model round trip per turn). `tool`: the model calls the tool itself.
 */
const PROFILE_CAPTURE =
	process.env.PROFILE_CAPTURE?.trim().toLowerCase() === "tool"
		? "tool"
		: "background";
const PROFILE_EXTRACT_MODEL =
	process.env.PROFILE_EXTRACT_MODEL?.trim() || "openai/gpt-5.4-nano";
const PROFILE_CAPTURE_NOTE = `

## PROFILE SAVING (automatic)
The caller's name and language preference are saved automatically from what they say. There is no tool for it: never try to save them yourself. If the name is unknown, ask for it once, then continue the booking. When the caller asks to switch language, just switch.`;

const STT_LANGUAGE: Record<CallLanguage, string> = {
	ar: "ar",
	fr: "fr",
	en: "en",
};

/**
 * Voice: `inworld` (Tunisian Arabic voices Nour/Omar) or `openrouter` (any
 * OpenRouter speech model, e.g. `google/gemini-3.8-flash-tts` + voice `Charon`).
 * Gemini TTS auto-detects the language from the text, so one voice covers
 * Derja, French and English.
 */
/**
 * `openrouter`: any OpenRouter speech model. `gemini`: Gemini TTS through
 * GEMINI_PROVIDER. `inference`: any LiveKit Inference TTS model (TTS_INFERENCE_MODEL).
 */
const TTS_PROVIDER = (() => {
	const raw = process.env.TTS_PROVIDER?.trim().toLowerCase();
	return raw === "openrouter" ||
		raw === "inference" ||
		raw === "gemini" ||
		raw === "openai"
		? raw
		: "inworld";
})();
const GOOGLE_TTS_MODEL =
	process.env.GOOGLE_TTS_MODEL?.trim() || "gemini-3.8-flash-lite-tts";
const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE?.trim() || "Charon";
const TTS_INFERENCE_MODEL =
	process.env.TTS_INFERENCE_MODEL?.trim() || "xai/tts-1";
const TTS_INFERENCE_VOICE = process.env.TTS_INFERENCE_VOICE?.trim();
const OPENROUTER_TTS_MODEL =
	process.env.OPENROUTER_TTS_MODEL?.trim() || "google/gemini-3.8-flash-tts";
const OPENROUTER_TTS_VOICE =
	process.env.OPENROUTER_TTS_VOICE?.trim() || "Charon";
/** The OpenAI plugin types `voice` as OpenAI's own names; OpenRouter takes any provider voice id. */
type OpenAIVoice = NonNullable<
	ConstructorParameters<typeof openai.TTS>[0]
>["voice"];

/**
 * Keyword biasing for MAI: speciality and city names in all three languages,
 * case-insensitively deduped and capped — Azure's phraseList (which this rides
 * on) degrades in latency/accuracy well past a few hundred entries.
 */
const MAI_PHRASES_MAX = 300;
const MAI_PHRASES = (() => {
	const seen = new Set<string>();
	const phrases: string[] = [];
	for (const raw of [
		"Riaya",
		"rendez-vous",
		...SPECIALITIES.flatMap((x) => [x.en_name, x.fr_name, x.ar_name]),
		...CITIES.flatMap((x) => [x.en_name, x.fr_name, x.ar_name]),
	]) {
		const key = raw.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		phrases.push(raw);
	}
	return phrases.slice(0, MAI_PHRASES_MAX);
})();

const logger = pino({
	level: process.env.LOG_LEVEL || "info",
	transport: { target: "pino-pretty", options: { colorize: true } },
});

// ==================== Per-call pipeline config ====================

/** Everything that picks the STT / LLM / TTS models, starting from `.env`. */
type PipelineConfig = {
	sttModel: string;
	geminiProvider: "openrouter" | "google";
	geminiSttModel: string;
	googleSttModel: string;
	sttReasoning: "none" | "minimal";
	whisperModel: string;
	llmProvider: string;
	livekitLlmModel: string;
	geminiLlmModel: string;
	googleLlmModel: string;
	openrouterModel: string;
	ttsProvider: string;
	openrouterTtsModel: string;
	openrouterTtsVoice: string;
	googleTtsModel: string;
	googleTtsVoice: string;
	geminiOpenrouterTtsModel: string;
	geminiOpenrouterTtsVoice: string;
	openaiTtsModel: string;
	openaiTtsVoice: string;
	openaiTtsInstructions: string | undefined;
	ttsInferenceModel: string;
	ttsInferenceVoice: string | undefined;
	inworldVoice: string;
	inworldTtsModel: string;
};

const ENV_PIPELINE: PipelineConfig = {
	sttModel: STT_MODEL,
	geminiProvider: GEMINI_PROVIDER,
	geminiSttModel: GEMINI_STT_MODEL,
	googleSttModel: GOOGLE_STT_MODEL,
	sttReasoning: GEMINI_STT_REASONING,
	whisperModel: OPENROUTER_WHISPER_MODEL,
	llmProvider: LLM_PROVIDER,
	livekitLlmModel: LIVEKIT_LLM_MODEL,
	geminiLlmModel: GEMINI_LLM_MODEL,
	googleLlmModel: GOOGLE_LLM_MODEL,
	openrouterModel: OPENROUTER_MODEL,
	ttsProvider: TTS_PROVIDER,
	openrouterTtsModel: OPENROUTER_TTS_MODEL,
	openrouterTtsVoice: OPENROUTER_TTS_VOICE,
	googleTtsModel: GOOGLE_TTS_MODEL,
	googleTtsVoice: GOOGLE_TTS_VOICE,
	geminiOpenrouterTtsModel: GEMINI_OPENROUTER_TTS_MODEL,
	geminiOpenrouterTtsVoice: GEMINI_OPENROUTER_TTS_VOICE,
	openaiTtsModel: OPENAI_TTS_MODEL,
	openaiTtsVoice: OPENAI_TTS_VOICE,
	openaiTtsInstructions: OPENAI_TTS_INSTRUCTIONS,
	ttsInferenceModel: TTS_INFERENCE_MODEL,
	ttsInferenceVoice: TTS_INFERENCE_VOICE,
	inworldVoice: INWORLD_VOICE,
	inworldTtsModel: INWORLD_TTS_MODEL,
};

/** Test-call page choices on top of `.env`; any combination is accepted. */
function resolvePipeline(
	settings: CallSettings["pipeline"] | undefined,
): PipelineConfig {
	const cfg: PipelineConfig = { ...ENV_PIPELINE };
	if (!settings) return cfg;

	const { stt, llm, tts } = settings;
	if (stt) {
		switch (stt.api) {
			case "openrouter-chat":
				cfg.sttModel = "openrouter-gemini";
				cfg.geminiSttModel = stt.model;
				cfg.sttReasoning = stt.reasoning ?? "minimal";
				break;
			case "openrouter-transcription":
				cfg.sttModel = "whisper";
				cfg.whisperModel = stt.model;
				break;
			case "google":
				cfg.sttModel = "google-gemini";
				cfg.googleSttModel = stt.model;
				break;
			case "inworld":
				cfg.sttModel = "inworld";
				break;
			case "openai":
			case "livekit-inference":
				cfg.sttModel = stt.model;
				break;
		}
	}
	if (llm) {
		if (llm.provider === "openrouter") {
			cfg.llmProvider = "openrouter";
			cfg.openrouterModel = llm.model;
		} else if (llm.provider === "google") {
			cfg.llmProvider = "google-gemini";
			cfg.googleLlmModel = llm.model;
		} else {
			cfg.llmProvider = "livekit";
			cfg.livekitLlmModel = llm.model;
		}
	}
	if (tts) {
		switch (tts.provider) {
			case "gemini-openrouter":
				cfg.ttsProvider = "gemini-openrouter";
				cfg.geminiOpenrouterTtsModel = tts.model;
				if (tts.voice) cfg.geminiOpenrouterTtsVoice = tts.voice;
				break;
			case "gemini-google":
				cfg.ttsProvider = "gemini-google";
				cfg.googleTtsModel = tts.model;
				if (tts.voice) cfg.googleTtsVoice = tts.voice;
				break;
			case "openai":
				cfg.ttsProvider = "openai";
				cfg.openaiTtsModel = tts.model;
				if (tts.voice) cfg.openaiTtsVoice = tts.voice;
				break;
			case "openrouter":
				cfg.ttsProvider = "openrouter";
				cfg.openrouterTtsModel = tts.model;
				if (tts.voice) cfg.openrouterTtsVoice = tts.voice;
				break;
			case "inworld":
				cfg.ttsProvider = "inworld";
				cfg.inworldTtsModel = tts.model;
				if (tts.voice) cfg.inworldVoice = tts.voice;
				break;
			case "inference":
				cfg.ttsProvider = "inference";
				cfg.ttsInferenceModel = tts.model;
				cfg.ttsInferenceVoice = tts.voice;
				break;
		}
	}
	return cfg;
}

export default defineAgent({
	prewarm: async (proc: JobProcess) => {
		proc.userData.vad = await silero.VAD.load();
	},

	entry: async (ctx: JobContext) => {
		const systemMessage = getSystemMessage("doctor-appointment");
		if (!systemMessage) throw new Error("System message not found");

		await ctx.connect();
		const participant = await ctx.waitForParticipant();
		const attrs = participant.attributes;
		const isSip = participant.kind === ParticipantKind.SIP;

		// SIP calls: number from LiveKit SIP, CallSid from the X-Twilio-CallSid
		// header mapped to an attribute by the inbound trunk. Browser test calls:
		// both come from token attributes set by the web token route.
		const callerPhone =
			(isSip ? attrs["sip.phoneNumber"] : attrs.callerPhone)?.trim() || null;
		const callSid =
			(isSip ? attrs["twilio.callSid"] : attrs.callSid)?.trim() ||
			`LK_${ctx.room.name}`;
		const log = logger.child({ callSid, room: ctx.room.name });
		log.info({ isSip, hasCallerPhone: Boolean(callerPhone) }, "📞 Call joined");

		// ---------- per-call state ----------
		let personId: number | null = null;
		let language: CallLanguage = "ar";
		let firstName: string | null = null;
		const callStartedAt = new Date();
		let callEnded = false;

		const relay = new DashboardRelay(log);
		const dbCallIdPromise = ensureCallRow({
			callSid,
			from: callerPhone ?? undefined,
		});
		const withCallId = (fn: (id: number) => Promise<unknown>) => {
			void dbCallIdPromise
				.then((id) => (id == null ? undefined : fn(id)))
				.catch((err) => log.error({ err }, "🔥 DB persistence error"));
		};
		const persistEvent = (event: Parameters<typeof createCallEvent>[1]) =>
			withCallId((id) => createCallEvent(id, event));
		const persistCallUpdate = (update: Parameters<typeof updateCall>[1]) =>
			withCallId((id) => updateCall(id, update));

		const applyPersonRow = (row: PersonRow) => {
			personId = row.id;
			firstName = row.firstName?.trim() || null;
			language = normalizeCallLanguage(row.preferredLanguage);
		};
		let refusalContext: CallerRefusalContext | null = null;
		let people: PersonOnLine[] = [];
		let lastPlace: CallerPlace | null = null;
		if (callerPhone) {
			const [row, refusal, onLine, place] = await Promise.all([
				ensurePersonRow(callerPhone),
				getCallerRefusalContext(callerPhone),
				getPeopleOnLine(callerPhone),
				getCallerLastPlace(callerPhone),
			]);
			if (row) applyPersonRow(row);
			refusalContext = refusal;
			lastPlace = place;
			people = onLine.length > 0 ? onLine : row ? ownerOnly(row) : [];
		}

		const instructions = () =>
			buildCallInstructions(systemMessage.message, {
				language,
				firstName,
				callerPhone,
				people,
				refusalContext,
				lastPlace,
			}) + (PROFILE_CAPTURE === "background" ? PROFILE_CAPTURE_NOTE : "");

		// ---------- pipeline ----------
		// Test-call page choices (simulated calls only); `.env` otherwise.
		const callSettings = await loadCallSettings(callSid, log);
		const cfg = resolvePipeline(callSettings?.pipeline);
		const sttHint =
			STT_LANGUAGE_HINT === "call"
				? (STT_LANGUAGE[language] as LanguageCode)
				: undefined;
		// MAI and Gemini STT are whole-utterance (non-streaming): LiveKit wraps
		// them with VAD and only has a transcript once the utterance is already
		// final, so there is nothing for preemptive generation to speculate on.
		const sttIsStreaming =
			cfg.sttModel !== "mai" &&
			cfg.sttModel !== "gemini" &&
			cfg.sttModel !== "openrouter-gemini" &&
			cfg.sttModel !== "google-gemini" &&
			cfg.sttModel !== "whisper";
		const stt = GPT_LIVE
			? null
			: cfg.sttModel === "google-gemini"
				? createGoogleGeminiStt({
						model: cfg.googleSttModel,
						onTiming: ({ ms, chars }) =>
							log.info({ ms, chars }, "🎙️ STT request time"),
					})
				: cfg.sttModel === "gemini"
					? (cfg.geminiProvider === "google"
							? createGoogleGeminiStt
							: createOpenRouterGeminiStt)({
							model:
								cfg.geminiProvider === "google"
									? cfg.googleSttModel
									: cfg.geminiSttModel,
							phrases: MAI_PHRASES,
							onTiming: ({ ms, chars }) =>
								log.info({ ms, chars }, "🎙️ STT request time"),
						})
					: cfg.sttModel === "openrouter-gemini"
						? createOpenRouterGeminiStt({
								model: cfg.geminiSttModel,
								phrases: MAI_PHRASES,
								reasoningEffort: cfg.sttReasoning,
								onTiming: ({ ms, chars }) =>
									log.info({ ms, chars }, "🎙️ STT request time"),
							})
						: cfg.sttModel === "whisper"
							? new OpenRouterTranscribeSTT({ model: cfg.whisperModel })
							: cfg.sttModel === "mai"
								? new MaiTranscribeSTT({
										fallbackLanguage: STT_LANGUAGE[language],
										phrases: MAI_PHRASES,
									})
								: cfg.sttModel === "inworld"
									? new inworld.STT({ language: STT_LANGUAGE[language] })
									: cfg.sttModel.startsWith("gpt-")
										? new openai.STT({
												model: cfg.sttModel,
												language: sttHint,
												// Without a hint the plugin would default to English.
												detectLanguage: sttHint === undefined,
											})
										: new inference.STT({
												model: cfg.sttModel,
												language: sttHint,
											});
		const tts = GPT_LIVE
			? null
			: cfg.ttsProvider === "gemini-google"
				? createGoogleGeminiTts(cfg.googleTtsModel, cfg.googleTtsVoice)
				: cfg.ttsProvider === "gemini-openrouter"
					? createOpenRouterGeminiTts(
							cfg.geminiOpenrouterTtsModel,
							cfg.geminiOpenrouterTtsVoice,
						)
					: cfg.ttsProvider === "openrouter"
						? new openai.TTS({
								baseURL: "https://openrouter.ai/api/v1",
								apiKey: process.env.OPENROUTER_API_KEY,
								model: cfg.openrouterTtsModel,
								voice: cfg.openrouterTtsVoice as OpenAIVoice,
							})
						: cfg.ttsProvider === "gemini"
							? cfg.geminiProvider === "google"
								? createGoogleGeminiTts(cfg.googleTtsModel, cfg.googleTtsVoice)
								: createOpenRouterGeminiTts(
										cfg.geminiOpenrouterTtsModel,
										cfg.geminiOpenrouterTtsVoice,
									)
							: cfg.ttsProvider === "openai"
								? createOpenAiTts({
										model: cfg.openaiTtsModel,
										voice: cfg.openaiTtsVoice,
										instructions: cfg.openaiTtsInstructions,
									})
								: cfg.ttsProvider === "inference"
									? new inference.TTS({
											model: cfg.ttsInferenceModel,
											voice: cfg.ttsInferenceVoice,
										})
									: new inworld.TTS({
											model: cfg.inworldTtsModel,
											voice: cfg.inworldVoice,
											language: TTS_LANGUAGE[language],
										});
		const model = GPT_LIVE
			? new openai.realtime.GPTLiveModel({
					voice: GPT_LIVE_VOICE,
					...(GPT_LIVE_BACKEND_MODEL
						? { responsesOptions: { model: GPT_LIVE_BACKEND_MODEL } }
						: {}),
				})
			: cfg.llmProvider === "google-gemini"
				? createGoogleGeminiLlm(cfg.googleLlmModel)
				: cfg.llmProvider === "livekit"
					? new inference.LLM({ model: cfg.livekitLlmModel })
					: cfg.llmProvider === "gemini"
						? cfg.geminiProvider === "google"
							? createGoogleGeminiLlm(cfg.googleLlmModel)
							: createOpenRouterGeminiLlm(cfg.geminiLlmModel)
						: new openai.LLM({
								model: cfg.openrouterModel,
								baseURL: "https://openrouter.ai/api/v1",
								apiKey: process.env.OPENROUTER_API_KEY,
							});
		log.info(
			{
				perCall: Boolean(callSettings?.pipeline),
				stt: stt ? `${stt.provider}/${stt.model}` : "gpt-live",
				sttLanguageHint: STT_LANGUAGE_HINT,
				tts: tts ? `${tts.provider}/${tts.model}` : "gpt-live",
				llm: GPT_LIVE
					? `gpt-live (voice ${GPT_LIVE_VOICE}, backend ${GPT_LIVE_BACKEND_MODEL ?? "default"})`
					: `${model.provider}/${model.model}`,
			},
			"🧠 LLM",
		);

		// ---------- tools ----------
		let pendingHangup = false;
		let hangupScheduled = false;

		const callTools = new CallTools({
			logger: log,
			callSid,
			callerPhone,
			get personId() {
				return personId;
			},
			lastPlace,
			applyPersonRow,
			onProfileChange: (change) => {
				if (change.firstName) firstName = change.firstName;
				if (change.preferredLanguage) {
					language = change.preferredLanguage;
					if (
						stt instanceof GeminiTranscribeSTT ||
						stt instanceof GoogleGeminiTranscribeSTT ||
						stt instanceof OpenRouterTranscribeSTT
					) {
						// No language state: the prompt already covers all three languages.
					} else if (stt instanceof MaiTranscribeSTT) {
						stt.setFallbackLanguage(STT_LANGUAGE[language]);
					} else if (stt instanceof inworld.STT) {
						stt.updateOptions({ language: STT_LANGUAGE[language] });
					} else if (stt && STT_LANGUAGE_HINT === "call") {
						// Inference STT types `language` as a branded code; ours is a plain BCP-47 string.
						stt.updateOptions({
							language: STT_LANGUAGE[language] as LanguageCode,
						});
					}
					// OpenRouter voices detect the language from the text; only Inworld needs a locale.
					if (tts instanceof inworld.TTS) {
						tts.updateOptions({ language: TTS_LANGUAGE[language] });
					}
				}
				if (GPT_LIVE) {
					// GPT-Live rejects instruction changes after the call starts; it
					// only accepts standing rules appended on top.
					const live = agent.duplexSession as openai.realtime.GPTLiveSession;
					if (change.firstName) {
						live.appendInstructions(
							`The caller's first name is ${change.firstName}.`,
						);
					}
					if (change.preferredLanguage) {
						const label = LANGUAGE_LABEL[change.preferredLanguage];
						live.appendInstructions(
							`The caller asked to speak ${label}. Reply only in ${label} from now on.`,
						);
					}
				} else {
					void agent.updateInstructions(instructions());
				}
			},
			emit: (message) => relay.send(message),
			persistEvent,
			persistCallUpdate,
		});

		const endCall = (args: unknown, reason: "done" | "abuse"): string => {
			watchdog.stop();
			pendingHangup = true;
			setTimeout(() => hangUp("fallback"), END_CALL_MAX_WAIT_MS);
			return buildHangupToolResult(
				normalizeCallLanguage(
					(args as { language?: string } | null)?.language ?? language,
				),
				reason,
			);
		};

		const executeTool = async (
			name: string,
			args: unknown,
		): Promise<string> => {
			if (name === "end_call") return endCall(args, "done");
			if (name === "report_abuse") {
				// Report first, then hang up whatever the report returned.
				await callTools.run(name, args);
				return endCall(args, "abuse");
			}
			return callTools.run(name, args);
		};

		const runTool = async (name: string, args: unknown): Promise<string> => {
			const argsJson = JSON.stringify(args ?? {});
			relay.send({
				type: "function_call",
				callSid,
				name,
				args: argsJson,
				status: "calling",
			});
			persistEvent({
				type: "function_call",
				functionName: name,
				functionArgs: args,
				functionStatus: "calling",
			});
			try {
				const result = await executeTool(name, args);
				relay.send({
					type: "function_call",
					callSid,
					name,
					args: argsJson,
					status: "success",
					result,
				});
				persistEvent({
					type: "function_call",
					functionName: name,
					functionArgs: args,
					functionResult: tryParseJson(result),
					functionStatus: "success",
				});
				return result;
			} catch (error) {
				const reason = toolFailureMessage(name, error);
				log.error({ tool: name, reason }, "🔥 Tool failed");
				relay.send({
					type: "function_call",
					callSid,
					name,
					args: argsJson,
					status: "error",
					result: reason,
				});
				persistEvent({
					type: "function_call",
					functionName: name,
					functionArgs: args,
					functionResult: reason,
					functionStatus: "error",
				});
				return JSON.stringify({ error: true, message: reason });
			}
		};

		// Tool schemas are reused verbatim from systemMessages.ts (raw JSON Schema).
		const tools = Object.fromEntries(
			systemMessage.tools
				.filter(
					({ name }) =>
						!(
							PROFILE_CAPTURE === "background" && name === "update_person_info"
						),
				)
				.map(({ name, description, parameters }) => [
					name,
					llm.tool({
						description,
						parameters,
						execute: async (args) => runTool(name, args),
					}),
				]),
		);

		const agent = new voice.Agent({ instructions: instructions(), tools });
		const session = new voice.AgentSession({
			stt: stt ?? undefined,
			llm: model,
			tts: tts ?? undefined,
			vad: ctx.proc.userData.vad as silero.VAD,
			// Silence is handled by CallWatchdog, shared with the media-stream path.
			userAwayTimeout: null,
			// GPT-Live detects the end of each turn itself.
			turnHandling: GPT_LIVE
				? undefined
				: {
						turnDetection: TURN_DETECTION,
						endpointing: { minDelay: ENDPOINTING_MIN_DELAY_MS },
						// Start the LLM on the latest transcript before the turn is confirmed.
						// Only useful with a streaming STT that has interim results to act on.
						preemptiveGeneration: { enabled: sttIsStreaming },
					},
		});

		// ---------- hangup ----------
		const hangUp = (reason: string) => {
			if (hangupScheduled) return;
			hangupScheduled = true;
			watchdog.stop();
			log.info({ reason }, "📴 Ending call");
			void ctx
				.deleteRoom()
				.catch((err) => log.error({ err }, "🔥 Failed to delete room"))
				.finally(() => ctx.shutdown("call ended"));
		};

		// ---------- silence / time limit ----------
		/** Say one goodbye line, then hang up once it has played (like end_call). */
		const endWithGoodbye = (prompt: WatchdogPrompt, note: string) => {
			if (pendingHangup || hangupScheduled) return;
			log.info({ prompt }, "📴 Watchdog ending call");
			persistEvent({ type: "system", content: note });
			pendingHangup = true;
			setTimeout(() => hangUp("fallback"), END_CALL_MAX_WAIT_MS);
			session.generateReply({
				instructions: buildWatchdogInstructions(prompt, language),
				allowInterruptions: false,
			});
		};
		const watchdog = new CallWatchdog(log, {
			onAskStillThere: () =>
				session.generateReply({
					instructions: buildWatchdogInstructions("still_there", language),
				}),
			onSilentGoodbye: () =>
				endWithGoodbye(
					"silent_goodbye",
					"Call ended: the caller stayed silent.",
				),
			onTimeLimit: () =>
				endWithGoodbye(
					"time_limit_goodbye",
					"Call ended: the call time limit was reached.",
				),
		});
		session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
			if (ev.newState === "speaking") watchdog.callerSpoke();
		});
		// thinking covers tool calls; listening means the reply has finished playing.
		session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
			watchdog.setAssistantSpeaking(ev.newState !== "listening");
		});

		// The reply that follows the end_call result is the goodbye; hang up once
		// it has finished playing.
		session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
			if (!pendingHangup || hangupScheduled) return;
			ev.speechHandle.addDoneCallback(() => hangUp("goodbye played"));
		});

		// ---------- dashboard / persistence ----------
		// ---------- background profile capture ----------
		let lastAssistantText = "";
		let profileQueue: Promise<void> = Promise.resolve();
		const capturedName = { first: false };
		const profileAbort = new AbortController();
		const captureProfile = (callerText: string) => {
			if (PROFILE_CAPTURE !== "background") return;
			const apiKey = process.env.OPENROUTER_API_KEY;
			if (!apiKey || callerText.trim().length < 2) return;
			// Empty before the greeting's ConversationItemAdded has fired (e.g. the
			// caller barges in before it finishes generating) — give the extraction
			// model an explicit note instead of a blank, unexplained field.
			const assistantText =
				lastAssistantText || "(call just started, no assistant message yet)";
			// Sequential, so two quick sentences can't race each other.
			profileQueue = profileQueue.then(async () => {
				if (profileAbort.signal.aborted) return;
				try {
					const found = await extractProfile({
						apiKey,
						model: PROFILE_EXTRACT_MODEL,
						assistantText,
						callerText,
						currentLanguage: language,
						signal: profileAbort.signal,
					});
					const args: Record<string, string> = {};
					// This saves the phone owner's profile. Only fill a missing name,
					// never replace one: a different name usually means someone else
					// is calling from the owner's phone (e.g. a spouse).
					if (found.first_name && !firstName && !capturedName.first) {
						args.first_name = found.first_name;
						if (found.last_name) args.last_name = found.last_name;
					}
					if (
						found.preferred_language &&
						found.preferred_language !== language
					) {
						args.preferred_language = found.preferred_language;
					}
					if (Object.keys(args).length === 0) return;
					if (args.first_name) capturedName.first = true;
					log.info({ args }, "👤 Profile captured in background");
					await runTool("update_person_info", args);
				} catch (err) {
					if (profileAbort.signal.aborted) return;
					log.warn({ err }, "Profile capture failed (ignored)");
				}
			});
		};

		session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
			if (!ev.transcript.trim()) return;
			if (!ev.isFinal) {
				// Live text for the admin page only: not logged, not persisted.
				relay.send({
					type: "patient_transcript",
					callSid,
					text: ev.transcript,
					isFinal: false,
				});
				return;
			}
			log.info({ transcript: ev.transcript }, "📝 Patient said");
			relay.send({
				type: "patient_transcript",
				callSid,
				text: ev.transcript,
				isFinal: true,
			});
			persistEvent({ type: "patient_transcript", content: ev.transcript });
			captureProfile(ev.transcript);
		});

		session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
			const item = ev.item;
			if (item.type !== "message" || item.role !== "assistant") return;
			const text = item.textContent?.trim();
			if (!text) return;
			lastAssistantText = text;
			relay.send({
				type: "ai_transcript",
				callSid,
				text,
				delta: "",
				isFinal: true,
			});
			persistEvent({ type: "ai_transcript", content: text });
		});

		// Per-stage timing so a slow turn can be traced to one stage in the log.
		session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
			const m = ev.metrics;
			if (m.type === "eou_metrics") {
				log.info(
					{
						waitedForSilenceMs: Math.round(m.endOfUtteranceDelayMs),
						transcriptWaitMs: Math.round(m.transcriptionDelayMs),
					},
					"⏱️ turn: end-of-speech wait and transcript wait",
				);
			} else if (m.type === "llm_metrics" && !m.cancelled) {
				log.info(
					{
						firstTokenMs: Math.round(m.ttftMs),
						totalMs: Math.round(m.durationMs),
						promptTokens: m.promptTokens,
						cachedTokens: m.promptCachedTokens,
					},
					"⏱️ LLM",
				);
			} else if (m.type === "tts_metrics" && !m.cancelled) {
				log.info(
					{
						firstAudioMs: Math.round(m.ttfbMs),
						totalMs: Math.round(m.durationMs),
						chars: m.charactersCount,
					},
					"⏱️ voice",
				);
			}
		});

		session.on(voice.AgentSessionEventTypes.Error, (ev) => {
			const message = errorMessage(ev.error);
			log.error({ error: ev.error }, "🔥 Agent session error");
			relay.send({ type: "error", callSid, message });
			persistEvent({ type: "error", content: message });
		});

		const finishCall = () => {
			watchdog.stop();
			if (callEnded) return;
			callEnded = true;
			profileAbort.abort();
			const endedAt = new Date();
			relay.send({
				type: "call_end",
				callSid,
				timestamp: endedAt.toISOString(),
			});
			persistCallUpdate({
				status: "completed",
				endedAt: endedAt.toISOString(),
				duration: Math.max(
					0,
					Math.floor((endedAt.getTime() - callStartedAt.getTime()) / 1000),
				),
			});
			// Give the relay a moment to flush before the process exits.
			setTimeout(() => relay.close(), 1000);
		};
		session.on(voice.AgentSessionEventTypes.Close, finishCall);
		ctx.addShutdownCallback(async () => finishCall());

		// ---------- start ----------
		relay.send({
			type: "call_start",
			callSid,
			timestamp: callStartedAt.toISOString(),
		});
		await session.start({ agent, room: ctx.room });

		// Live AI text for the admin page: tap the transcription output, which
		// still forwards everything to the room unchanged. The final text is
		// sent (and saved) from ConversationItemAdded; these partials are not.
		const sink = session.output.transcription;
		if (sink) {
			let aiPartial = "";
			const captureText = sink.captureText.bind(sink);
			const flush = sink.flush.bind(sink);
			sink.captureText = async (chunk) => {
				const delta = typeof chunk === "string" ? chunk : chunk.text;
				if (delta) {
					aiPartial += delta;
					relay.send({
						type: "ai_transcript",
						callSid,
						text: aiPartial,
						delta,
						isFinal: false,
					});
				}
				return captureText(chunk);
			};
			sink.flush = () => {
				aiPartial = "";
				flush();
			};
		}

		session.generateReply({
			instructions: buildInitialGreetingInstructions(language, firstName),
		});
		watchdog.start();
	},
});

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") {
		const body = error as { message?: unknown; error?: unknown };
		if (typeof body.message === "string" && body.message) return body.message;
		if (body.error !== undefined) return errorMessage(body.error);
		try {
			return JSON.stringify(error);
		} catch {
			return "Unknown error";
		}
	}
	return String(error);
}

function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

cli.runApp(
	new ServerOptions({
		agent: fileURLToPath(import.meta.url),
		agentName: AGENT_NAME,
	}),
);
