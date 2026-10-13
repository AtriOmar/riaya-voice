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
import { createCallEvent, ensureCallRow, updateCall } from "../api/callsApi.js";
import { ensurePersonRow } from "../api/personsApi.js";
import { CITIES } from "../constants/cities.js";
import { SPECIALITIES } from "../constants/specialities.js";
import {
	buildCallInstructions,
	buildInitialGreetingInstructions,
	type CallLanguage,
	LANGUAGE_LABEL,
	normalizeCallLanguage,
} from "../sessions/callInstructions.js";
import { getSystemMessage } from "../sessions/systemMessages.js";
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
		if (callerPhone) {
			const row = await ensurePersonRow(callerPhone);
			if (row) applyPersonRow(row);
		}

		const instructions = () =>
			buildCallInstructions(systemMessage.message, {
				language,
				firstName,
				callerPhone,
			}) + (PROFILE_CAPTURE === "background" ? PROFILE_CAPTURE_NOTE : "");

		// ---------- pipeline ----------
		const sttHint =
			STT_LANGUAGE_HINT === "call"
				? (STT_LANGUAGE[language] as LanguageCode)
				: undefined;
		// MAI and Gemini STT are whole-utterance (non-streaming): LiveKit wraps
		// them with VAD and only has a transcript once the utterance is already
		// final, so there is nothing for preemptive generation to speculate on.
		const sttIsStreaming =
			STT_MODEL !== "mai" &&
			STT_MODEL !== "gemini" &&
			STT_MODEL !== "openrouter-gemini" &&
			STT_MODEL !== "whisper";
		const stt = GPT_LIVE
			? null
			: STT_MODEL === "gemini"
				? (GEMINI_PROVIDER === "google"
						? createGoogleGeminiStt
						: createOpenRouterGeminiStt)({
						model:
							GEMINI_PROVIDER === "google"
								? GOOGLE_STT_MODEL
								: GEMINI_STT_MODEL,
						phrases: MAI_PHRASES,
						onTiming: ({ ms, chars }) =>
							log.info({ ms, chars }, "🎙️ STT request time"),
					})
				: STT_MODEL === "openrouter-gemini"
					? createOpenRouterGeminiStt({
							model: GEMINI_STT_MODEL,
							phrases: MAI_PHRASES,
							reasoningEffort: GEMINI_STT_REASONING,
							onTiming: ({ ms, chars }) =>
								log.info({ ms, chars }, "🎙️ STT request time"),
						})
					: STT_MODEL === "whisper"
						? new OpenRouterTranscribeSTT({ model: OPENROUTER_WHISPER_MODEL })
						: STT_MODEL === "mai"
							? new MaiTranscribeSTT({
									fallbackLanguage: STT_LANGUAGE[language],
									phrases: MAI_PHRASES,
								})
							: STT_MODEL === "inworld"
								? new inworld.STT({ language: STT_LANGUAGE[language] })
								: STT_MODEL.startsWith("gpt-")
									? new openai.STT({
											model: STT_MODEL,
											language: sttHint,
											// Without a hint the plugin would default to English.
											detectLanguage: sttHint === undefined,
										})
									: new inference.STT({ model: STT_MODEL, language: sttHint });
		const tts = GPT_LIVE
			? null
			: TTS_PROVIDER === "openrouter"
				? new openai.TTS({
						baseURL: "https://openrouter.ai/api/v1",
						apiKey: process.env.OPENROUTER_API_KEY,
						model: OPENROUTER_TTS_MODEL,
						voice: OPENROUTER_TTS_VOICE as OpenAIVoice,
					})
				: TTS_PROVIDER === "gemini"
					? GEMINI_PROVIDER === "google"
						? createGoogleGeminiTts(GOOGLE_TTS_MODEL, GOOGLE_TTS_VOICE)
						: createOpenRouterGeminiTts(
								GEMINI_OPENROUTER_TTS_MODEL,
								GEMINI_OPENROUTER_TTS_VOICE,
							)
					: TTS_PROVIDER === "openai"
						? createOpenAiTts({
								model: OPENAI_TTS_MODEL,
								voice: OPENAI_TTS_VOICE,
								instructions: OPENAI_TTS_INSTRUCTIONS,
							})
						: TTS_PROVIDER === "inference"
							? new inference.TTS({
									model: TTS_INFERENCE_MODEL,
									voice: TTS_INFERENCE_VOICE,
								})
							: new inworld.TTS({
									model: INWORLD_TTS_MODEL,
									voice: INWORLD_VOICE,
									language: TTS_LANGUAGE[language],
								});
		const model = GPT_LIVE
			? new openai.realtime.GPTLiveModel({
					voice: GPT_LIVE_VOICE,
					...(GPT_LIVE_BACKEND_MODEL
						? { responsesOptions: { model: GPT_LIVE_BACKEND_MODEL } }
						: {}),
				})
			: LLM_PROVIDER === "livekit"
				? new inference.LLM({ model: LIVEKIT_LLM_MODEL })
				: LLM_PROVIDER === "gemini"
					? GEMINI_PROVIDER === "google"
						? createGoogleGeminiLlm(GOOGLE_LLM_MODEL)
						: createOpenRouterGeminiLlm(GEMINI_LLM_MODEL)
					: new openai.LLM({
							model: OPENROUTER_MODEL,
							baseURL: "https://openrouter.ai/api/v1",
							apiKey: process.env.OPENROUTER_API_KEY,
						});
		log.info(
			{
				llmProvider: LLM_PROVIDER,
				sttModel: STT_MODEL === "gemini" ? GEMINI_STT_MODEL : STT_MODEL,
				sttLanguageHint: STT_LANGUAGE_HINT,
				ttsProvider: TTS_PROVIDER,
				ttsVoice:
					TTS_PROVIDER === "openrouter"
						? OPENROUTER_TTS_VOICE
						: TTS_PROVIDER === "gemini"
							? GEMINI_PROVIDER === "google"
								? GOOGLE_TTS_VOICE
								: GEMINI_OPENROUTER_TTS_VOICE
							: TTS_PROVIDER === "openai"
								? OPENAI_TTS_VOICE
								: INWORLD_VOICE,
				ttsModel:
					TTS_PROVIDER === "openrouter"
						? OPENROUTER_TTS_MODEL
						: TTS_PROVIDER === "gemini"
							? GEMINI_PROVIDER === "google"
								? GOOGLE_TTS_MODEL
								: GEMINI_OPENROUTER_TTS_MODEL
							: TTS_PROVIDER === "openai"
								? OPENAI_TTS_MODEL
								: TTS_PROVIDER === "inference"
									? TTS_INFERENCE_MODEL
									: INWORLD_TTS_MODEL,
				llmModel: GPT_LIVE
					? `gpt-live (voice ${GPT_LIVE_VOICE}, backend ${GPT_LIVE_BACKEND_MODEL ?? "default"})`
					: LLM_PROVIDER === "livekit"
						? LIVEKIT_LLM_MODEL
						: LLM_PROVIDER === "gemini"
							? GEMINI_PROVIDER === "google"
								? GOOGLE_LLM_MODEL
								: GEMINI_LLM_MODEL
							: OPENROUTER_MODEL,
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

		const endCall = (args: unknown): string => {
			pendingHangup = true;
			const lang = normalizeCallLanguage(
				(args as { language?: string } | null)?.language ?? language,
			);
			const langHint =
				lang === "fr"
					? "French"
					: lang === "en"
						? "English"
						: "Tunisian Arabic (Derja)";
			setTimeout(() => hangUp("fallback"), END_CALL_MAX_WAIT_MS);
			return JSON.stringify({
				success: true,
				message: `Call disconnect is scheduled when this response finishes. Say a brief thank-you and goodbye to the patient now (one short sentence, ${langHint}). Do not call other tools.`,
			});
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
				const result =
					name === "end_call" ? endCall(args) : await callTools.run(name, args);
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
			log.info({ reason }, "📴 Ending call");
			void ctx
				.deleteRoom()
				.catch((err) => log.error({ err }, "🔥 Failed to delete room"))
				.finally(() => ctx.shutdown("call ended"));
		};

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
					if (found.first_name && found.first_name !== firstName) {
						args.first_name = found.first_name;
						if (found.last_name) args.last_name = found.last_name;
					} else if (found.last_name && !capturedName.first) {
						args.last_name = found.last_name;
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
