import { DefaultAzureCredential } from "@azure/identity";
import axios from "axios";
import type { Logger } from "pino";
import twilio from "twilio";
import { type RawData, WebSocket } from "ws";
import { createCallEvent, ensureCallRow, updateCall } from "../api/callsApi.js";
import { nextjsApi } from "../api/nextjsApiClient.js";
import { ensurePersonRow, updatePersonRow } from "../api/personsApi.js";
import { CITIES } from "../constants/cities.js";
import { SPECIALITIES } from "../constants/specialities.js";
import type {
	BestFitDoctor,
	BookAppointmentParams,
	DashboardMessage,
	DoctorAvailabilityResponse,
	SystemMessage,
	TwilioMediaMessage,
} from "../types/index.js";

const {
	BACKEND,
	OPENAI_API_KEY,
	OPENAI_ENDPOINT,
	OPENAI_MODEL,
	OPENAI_API_VERSION,
} = process.env as Record<string, string>;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

let twilioRestClient: ReturnType<typeof twilio> | null = null;

function getTwilioRestClient(): ReturnType<typeof twilio> | null {
	if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
	if (!twilioRestClient) {
		twilioRestClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
	}
	return twilioRestClient;
}

// ==================== Session Config ====================

const SESSION_CONFIG = {
	modalities: ["text", "audio"],
	voice: "ash",
	input_audio_format: "g711_ulaw",
	output_audio_format: "g711_ulaw",
	input_audio_transcription: {
		model: process.env.INPUT_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-transcribe",
		prompt:
			"The audio may be in Tunisian Arabic (Tunisian Derja), English, or French — transcribe in whatever language the caller uses; do not translate to another language. " +
			"Context: patients calling Riaya, a healthcare platform in Tunisia, to book doctor appointments by phone. " +
			"Expect symptoms and reasons for visit; medical speciality names; Tunisian city and neighborhood names; doctor and clinic (cabinet) names; " +
			"dates and times patients mention (often Tunisia local time, GMT+1); booking and confirmation phrases; phone numbers and people's names.",
	},
	turn_detection: {
		type: "server_vad",
		threshold: parseFloat(process.env.VAD_THRESHOLD || "0.5"),
		silence_duration_ms: parseInt(process.env.SILENCE_DURATION_MS || "600", 10),
	},
	tool_choice: "auto",
	max_response_output_tokens: parseInt(
		process.env.MAX_OUTPUT_TOKENS || "4096",
		10,
	),
};

// ==================== Tool / HTTP logging ====================

const MAX_LOG_CHARS = 8000;

function truncateForLog(value: string, max = MAX_LOG_CHARS): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…[truncated, ${value.length} chars total]`;
}

function tryParseJsonString(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function bodyFromAxiosConfig(data: unknown): unknown {
	if (data == null) return data;
	if (typeof data === "string") return tryParseJsonString(data) ?? data;
	return data;
}

function consoleLogToolHttpError(
	tool: string,
	ctx: { callSid?: string | null; call_id?: string; input?: unknown },
	error: unknown,
): void {
	console.log("---------------------- TOOL HTTP ERROR ----------------------");
	console.log("tool:", tool);
	console.log("callSid:", ctx.callSid);
	console.log("call_id:", ctx.call_id);
	console.log("input:", JSON.stringify(ctx.input, null, 2));
	if (axios.isAxiosError(error)) {
		console.log("axiosMessage:", error.message);
		console.log("axiosCode:", error.code);
		console.log(
			"httpStatus:",
			error.response?.status,
			error.response?.statusText,
		);
		console.log("responseData:", error.response?.data);
		console.log("requestUrl:", error.config?.url);
		console.log("requestMethod:", error.config?.method);
		console.log("requestParams:", error.config?.params);
		console.log("requestBody:", bodyFromAxiosConfig(error.config?.data));
	} else {
		console.log("non-axios error:", error);
	}
	console.log("-------------------------------------------------------------");
}

function toolFailureMessage(tool: string, error: unknown): string {
	if (axios.isAxiosError(error)) {
		const status = error.response?.status;
		const data = error.response?.data;
		const detail =
			data === undefined || data === null
				? ""
				: typeof data === "string"
					? truncateForLog(data, 2500)
					: truncateForLog(JSON.stringify(data), 2500);
		const suffix = detail ? ` — ${detail}` : "";
		return `${tool}: HTTP ${String(status ?? "?")} ${error.message}${suffix}`;
	}
	if (error instanceof Error) return `${tool}: ${error.message}`;
	return `${tool}: ${String(error)}`;
}

type FindAvailableSlotsArgs = {
	specialitySlug: string;
	latitude: number;
	longitude: number;
	preferredTime?: string;
};

type FindDoctorSlotsArgs = {
	doctorId: number;
	preferredTime?: string;
	limit?: number;
};

type BookAppointmentToolArgs = {
	doctorId: number | string;
	patientName: string;
	illness: string;
	start: string;
	end: string;
};

function phoneDigitsOnly(raw: string): string {
	return raw.replace(/\D/g, "");
}

type UpdatePersonInfoToolArgs = {
	firstName?: string;
	lastName?: string;
	dateOfBirth?: string;
	gender?: string;
	address?: string;
};

function strField(
	raw: Record<string, unknown>,
	snake: string,
	camel: string,
): string | undefined {
	const a = raw[snake];
	const b = raw[camel];
	if (typeof a === "string" && a.length > 0) return a;
	if (typeof b === "string" && b.length > 0) return b;
	return undefined;
}

function numField(
	raw: Record<string, unknown>,
	snake: string,
	camel: string,
): number | undefined {
	const a = raw[snake];
	const b = raw[camel];
	for (const v of [a, b]) {
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return undefined;
}

/** Accepts snake_case (tool schema) or legacy camelCase; maps to internal shape for HTTP. */
function normalizeFindAvailableSlotsArgs(
	raw: unknown,
): FindAvailableSlotsArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const specialitySlug = strField(o, "speciality_slug", "specialitySlug") ?? "";
	const latitude = numField(o, "latitude", "latitude");
	const longitude = numField(o, "longitude", "longitude");
	const preferredTime = strField(o, "preferred_time", "preferredTime");
	if (latitude === undefined || longitude === undefined) return null;
	return {
		specialitySlug,
		latitude,
		longitude,
		...(preferredTime !== undefined ? { preferredTime } : {}),
	};
}

/** Accepts snake_case (tool schema) or legacy camelCase; maps to internal shape for HTTP. */
function normalizeFindDoctorSlotsArgs(
	raw: unknown,
): FindDoctorSlotsArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const doctorIdRaw = o.doctor_id ?? o.doctorId;
	const preferredTime = strField(o, "preferred_time", "preferredTime");
	const limitRaw = o.limit;

	let doctorId: number | null = null;
	if (typeof doctorIdRaw === "number") doctorId = doctorIdRaw;
	if (typeof doctorIdRaw === "string" && doctorIdRaw.trim() !== "") {
		const parsed = Number(doctorIdRaw);
		if (Number.isFinite(parsed)) doctorId = parsed;
	}
	if (
		doctorId === null ||
		!Number.isInteger(doctorId) ||
		!Number.isFinite(doctorId) ||
		doctorId <= 0
	) {
		return null;
	}

	let limit: number | undefined;
	if (typeof limitRaw === "number" && Number.isFinite(limitRaw)) {
		limit = Math.max(1, Math.min(10, Math.floor(limitRaw)));
	}
	if (typeof limitRaw === "string" && limitRaw.trim() !== "") {
		const parsed = Number(limitRaw);
		if (Number.isFinite(parsed)) {
			limit = Math.max(1, Math.min(10, Math.floor(parsed)));
		}
	}

	return {
		doctorId,
		...(preferredTime !== undefined ? { preferredTime } : {}),
		...(limit !== undefined ? { limit } : {}),
	};
}

/** Accepts snake_case (tool schema) or legacy camelCase; maps to internal shape for HTTP. */
function normalizeBookAppointmentArgs(
	raw: unknown,
): BookAppointmentToolArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const doctorId = o.doctor_id ?? o.doctorId;
	const patientName = strField(o, "patient_name", "patientName");
	const illness = strField(o, "illness", "illness");
	const start = strField(o, "start", "start");
	const end = strField(o, "end", "end");
	if (
		patientName === undefined ||
		illness === undefined ||
		start === undefined ||
		end === undefined
	) {
		return null;
	}
	return {
		doctorId: doctorId as number | string,
		patientName,
		illness,
		start,
		end,
	};
}

/** Accepts snake_case (tool schema) or legacy camelCase; maps to internal shape for HTTP. */
function normalizeUpdatePersonInfoArgs(
	raw: unknown,
): UpdatePersonInfoToolArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const firstName = strField(o, "first_name", "firstName");
	const lastName = strField(o, "last_name", "lastName");
	const dateOfBirth = strField(o, "date_of_birth", "dateOfBirth");
	const gender = strField(o, "gender", "gender");
	const address = strField(o, "address", "address");

	if (
		firstName === undefined &&
		lastName === undefined &&
		dateOfBirth === undefined &&
		gender === undefined &&
		address === undefined
	) {
		return null;
	}

	return {
		...(firstName !== undefined ? { firstName } : {}),
		...(lastName !== undefined ? { lastName } : {}),
		...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
		...(gender !== undefined ? { gender } : {}),
		...(address !== undefined ? { address } : {}),
	};
}

// ==================== OpenAI Realtime Event Types ====================

const EVENTS = {
	SessionCreated: "session.created",
	SessionUpdated: "session.updated",
	InputAudioBufferSpeechStarted: "input_audio_buffer.speech_started",
	InputAudioBufferSpeechStopped: "input_audio_buffer.speech_stopped",
	InputAudioBufferCommitted: "input_audio_buffer.committed",
	ResponseAudioDelta: "response.audio.delta",
	ResponseAudioDone: "response.audio.done",
	ResponseAudioTranscriptDelta: "response.audio_transcript.delta",
	ResponseAudioTranscriptDone: "response.audio_transcript.done",
	ResponseFunctionCallArgumentsDone: "response.function_call_arguments.done",
	ResponseDone: "response.done",
	Error: "error",
	ConversationItemCreated: "conversation.item.created",
	ConversationItemInputAudioTranscriptionCompleted:
		"conversation.item.input_audio_transcription.completed",
	ConversationItemInputAudioTranscriptionFailed:
		"conversation.item.input_audio_transcription.failed",
	RateLimitsUpdated: "rate_limits.updated",
	ResponseOutputItemDone: "response.output_item.done",
};

// ==================== TwilioSession ====================

export class TwilioSession {
	// Azure auth token cache (shared across sessions)
	private static tokenCache: { token: string; expires: number } | null = null;
	private static readonly TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

	// Connection state
	private openAIWs!: WebSocket;
	private streamSid: string | null = null;
	private callSid: string | null = null;

	// Audio playback tracking (for interruption handling)
	private latestMediaTimestamp = 0;
	private responseStartTimestampTwilio: number | null = null;
	private lastAssistantItem: string | null = null;
	private markQueue: string[] = [];

	// AI transcript accumulator (per response)
	private currentAiTranscript = "";

	/** E.164 (or Twilio-provided) caller ID from Stream customParameters */
	private callerPhone: string | null = null;

	/** DB id of the person record for this caller (set once callerPhone is known). */
	private personId: number | null = null;

	/** Only the first session.update should trigger the opening greeting */
	private initialGreetingSent = false;

	/** Next.js DB row id for this call (available once ensureCallRow resolves). */
	private dbCallIdPromise: Promise<number | null> | null = null;
	private callStartedAt: Date | null = null;

	/** Avoid stacking multiple Twilio REST hangups for one session. */
	private hangupScheduled = false;

	constructor(
		private readonly twilioWs: WebSocket,
		private readonly logger: Logger,
		private readonly systemMessage: SystemMessage,
		private readonly dashboardClients: Set<WebSocket>,
	) {
		this.logger.info("🟢 TwilioSession created");
		this.initialize().catch((error) =>
			this.logger.error({ error }, "🔥 Failed to initialize TwilioSession"),
		);
	}

	// ==================== Initialization ====================

	private async initialize() {
		// Set up Twilio handlers FIRST so we don't miss early events (start, connected)
		// that Twilio sends immediately after the WebSocket is established
		this.setupTwilioHandlers();
		this.openAIWs = await this.connectToOpenAI();
		this.setupOpenAIHandlers();
	}

	private connectToOpenAI(): Promise<WebSocket> {
		const url =
			BACKEND === "azure"
				? `${OPENAI_ENDPOINT.replace("https://", "wss://")}/openai/realtime?deployment=${OPENAI_MODEL}&api-version=${OPENAI_API_VERSION}`
				: `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL || "gpt-4o-realtime-preview"}`;

		this.logger.info(`🔌 Connecting to OpenAI at ${url}`);

		// biome-ignore lint/suspicious/noAsyncPromiseExecutor: I found the code already like this and it seems to be working fine --- IGNORE ---
		return new Promise(async (resolve, reject) => {
			const headers = await this.getHeaders();
			const ws = new WebSocket(url, { headers });

			ws.on("open", () => {
				this.logger.info("🟢 OpenAI WebSocket connected");
				resolve(ws);
			});

			ws.on("error", (error) => {
				this.logger.error({ error }, "🔥 OpenAI WebSocket connection error");
				reject(error);
			});
		});
	}

	private async getHeaders(): Promise<Record<string, string>> {
		if (BACKEND === "azure") {
			if (OPENAI_API_KEY) {
				this.logger.info("✅ Using Azure API key");
				return { "api-key": OPENAI_API_KEY };
			}

			// Managed identity fallback
			const now = Date.now();
			if (
				TwilioSession.tokenCache &&
				TwilioSession.tokenCache.expires >
					now + TwilioSession.TOKEN_REFRESH_THRESHOLD_MS
			) {
				return { Authorization: `Bearer ${TwilioSession.tokenCache.token}` };
			}

			const token = await new DefaultAzureCredential().getToken(
				"https://cognitiveservices.azure.com/.default",
			);
			if (!token?.token)
				throw new Error("Failed to retrieve Azure access token");

			TwilioSession.tokenCache = {
				token: token.token,
				expires: token.expiresOnTimestamp,
			};
			return { Authorization: `Bearer ${token.token}` };
		}

		if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
		return {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			"OpenAI-Beta": "realtime=v1",
		};
	}

	private buildSessionInstructions(): string {
		if (!this.callerPhone) return this.systemMessage.message;
		return `${this.systemMessage.message}

## CALLER PHONE (THIS LINE)
The phone number for this call is: **${this.callerPhone}**.
The server uses this number automatically when \`book_appointment\` runs. Do **not** ask the patient about their phone number.`;
	}

	private sendSessionConfig() {
		if (this.openAIWs?.readyState !== WebSocket.OPEN) return;

		this.openAIWs.send(
			JSON.stringify({
				type: "session.update",
				session: {
					instructions: this.buildSessionInstructions(),
					tools: this.systemMessage.tools,
					...SESSION_CONFIG,
				},
			}),
		);
		this.logger.info(
			{ hasCallerPhone: Boolean(this.callerPhone) },
			"✅ Session config sent to OpenAI",
		);
	}

	private sendInitialGreeting() {
		if (this.openAIWs?.readyState !== WebSocket.OPEN) return;

		this.openAIWs.send(
			JSON.stringify({
				type: "response.create",
				response: {
					modalities: ["text", "audio"],
					instructions: this.systemMessage.initialInstructions,
				},
			}),
		);
		this.logger.info("🗣️ Initial greeting triggered");
	}

	// ==================== OpenAI Event Handlers ====================

	private setupOpenAIHandlers() {
		this.openAIWs.on("message", (data: RawData) =>
			this.handleOpenAIMessage(data),
		);
		this.openAIWs.on("close", () => {
			this.logger.info("🔴 OpenAI WebSocket closed");
			this.dispose();
		});
		this.openAIWs.on("error", (error) =>
			this.logger.error({ error }, "🔥 OpenAI WebSocket error"),
		);
	}

	private handleOpenAIMessage(data: RawData) {
		try {
			const event = JSON.parse(data.toString());
			console.log("-------------------- event --------------------");
			console.log(event);

			// biome-ignore lint/suspicious/noExplicitAny: screw this
			const handlers: Record<string, (e: any) => void> = {
				[EVENTS.SessionCreated]: () => {
					this.logger.info("✅ OpenAI session created");
					this.sendSessionConfig();
				},

				[EVENTS.SessionUpdated]: () => {
					this.logger.info("✅ Session config updated");
					if (!this.initialGreetingSent) {
						this.initialGreetingSent = true;
						this.sendInitialGreeting();
					}
				},

				[EVENTS.ResponseAudioDelta]: (e) => this.handleAudioDelta(e),

				[EVENTS.ResponseAudioTranscriptDelta]: (e) => {
					if (e.delta && this.callSid) {
						this.currentAiTranscript += e.delta;
						this.broadcastDashboard({
							type: "ai_transcript",
							callSid: this.callSid,
							text: this.currentAiTranscript,
							delta: e.delta,
							isFinal: false,
						});
					}
				},

				[EVENTS.ResponseAudioTranscriptDone]: (e) => {
					if (this.callSid) {
						const finalText = e.transcript || this.currentAiTranscript;
						this.broadcastDashboard({
							type: "ai_transcript",
							callSid: this.callSid,
							text: finalText,
							delta: "",
							isFinal: true,
						});
						if (finalText) {
							this.persistEvent({
								type: "ai_transcript",
								content: finalText,
							});
						}
						this.currentAiTranscript = "";
					}
				},

				[EVENTS.InputAudioBufferSpeechStarted]: () =>
					this.handleSpeechStarted(),

				[EVENTS.ConversationItemInputAudioTranscriptionCompleted]: (e) => {
					if (e.transcript && this.callSid) {
						this.logger.info({ transcript: e.transcript }, "📝 Patient said");
						this.broadcastDashboard({
							type: "patient_transcript",
							callSid: this.callSid,
							text: e.transcript,
							isFinal: true,
						});
						this.persistEvent({
							type: "patient_transcript",
							content: e.transcript,
						});
					}
				},

				[EVENTS.ConversationItemInputAudioTranscriptionFailed]: (e) =>
					this.logger.error({ error: e.error }, "🔥 Transcription failed"),

				[EVENTS.ResponseFunctionCallArgumentsDone]: (e) =>
					this.handleFunctionCall(e),

				[EVENTS.ResponseDone]: () => this.logger.debug("✅ Response complete"),

				[EVENTS.Error]: (e) => {
					this.logger.error({ error: e.error }, "🔥 OpenAI error");
					if (this.callSid) {
						const message = e.error?.message || "OpenAI error";
						this.broadcastDashboard({
							type: "error",
							callSid: this.callSid,
							message,
						});
						this.persistEvent({ type: "error", content: message });
					}
				},

				[EVENTS.RateLimitsUpdated]: (e) =>
					this.logger.info({ rateLimits: e.rate_limits }, "📊 Rate limits"),
			};

			const handler = handlers[event.type];
			if (handler) {
				handler(event);
			}
		} catch (error) {
			this.logger.error({ error }, "🔥 Error processing OpenAI message");
		}
	}

	// ==================== Twilio Event Handlers ====================

	private setupTwilioHandlers() {
		this.twilioWs.on("message", (data: RawData) =>
			this.handleTwilioMessage(data),
		);
		this.twilioWs.on("close", () => {
			this.logger.info("🔴 Twilio WebSocket closed");
			if (this.callSid) {
				const endedAt = new Date();
				const duration = this.callStartedAt
					? Math.max(
							0,
							Math.floor(
								(endedAt.getTime() - this.callStartedAt.getTime()) / 1000,
							),
						)
					: undefined;
				this.broadcastDashboard({
					type: "call_end",
					callSid: this.callSid,
					timestamp: endedAt.toISOString(),
				});
				this.persistCallUpdate({
					status: "completed",
					endedAt: endedAt.toISOString(),
					...(duration !== undefined ? { duration } : {}),
				});
			}
			this.dispose();
		});
		this.twilioWs.on("error", (error) =>
			this.logger.error({ error }, "🔥 Twilio WebSocket error"),
		);
	}

	private handleTwilioMessage(data: RawData) {
		try {
			const msg: TwilioMediaMessage = JSON.parse(data.toString());

			console.log("-------------------- msg --------------------");
			console.log(msg);
			switch (msg.event) {
				case "connected":
					this.logger.info(
						{ protocol: msg.protocol, version: msg.version },
						"📞 Twilio WebSocket connected",
					);
					break;

				case "start": {
					this.streamSid = msg.streamSid;
					this.callSid = msg.start.callSid;
					const params = msg.start.customParameters ?? {};
					const raw =
						typeof params.callerPhone === "string"
							? params.callerPhone
							: typeof params.from === "string"
								? params.from
								: "";
					const trimmed = raw.trim();
					this.callerPhone = trimmed.length > 0 ? trimmed : null;
					this.callStartedAt = new Date();

					// Ensure person exists (idempotent — /incoming-call likely already started this).
					if (this.callerPhone) {
						void ensurePersonRow(this.callerPhone).then((id) => {
							this.personId = id;
							if (id != null) {
								this.logger.info({ personId: id }, "👤 Person upserted");
							}
						});
					}

					// Ensure DB row exists (idempotent — /incoming-call likely already started this).
					this.dbCallIdPromise = ensureCallRow({
						callSid: this.callSid,
						from: this.callerPhone ?? undefined,
					});

					this.logger.info(
						{
							streamSid: this.streamSid,
							callSid: this.callSid,
							hasCallerPhone: Boolean(this.callerPhone),
							callerPhone: this.callerPhone,
						},
						"📞 Twilio stream started",
					);
					this.broadcastDashboard({
						type: "call_start",
						callSid: this.callSid,
						timestamp: this.callStartedAt.toISOString(),
					});

					// Caller may arrive after OpenAI is connected; refresh instructions without re-greeting
					if (this.openAIWs?.readyState === WebSocket.OPEN) {
						this.sendSessionConfig();
					}
					break;
				}

				case "media":
					this.latestMediaTimestamp = parseInt(msg.media.timestamp, 10);

					// Forward audio to OpenAI
					if (this.openAIWs?.readyState === WebSocket.OPEN) {
						this.openAIWs.send(
							JSON.stringify({
								type: "input_audio_buffer.append",
								audio: msg.media.payload,
							}),
						);
					}

					// Forward audio to dashboard clients listening to this call
					if (this.callSid) {
						this.broadcastDashboard({
							type: "patient_audio",
							callSid: this.callSid,
							payload: msg.media.payload,
						});
					}
					break;

				case "mark":
					if (this.markQueue.length > 0) {
						this.markQueue.shift();
					}
					break;

				case "stop":
					this.logger.info("📞 Twilio stream stopped");
					break;

				default:
					break;
			}
		} catch (error) {
			this.logger.error({ error }, "🔥 Error parsing Twilio message");
		}
	}

	// ==================== Audio Handling ====================

	// biome-ignore lint/suspicious/noExplicitAny: ignore
	private handleAudioDelta(event: any) {
		if (!event.delta || !this.streamSid) return;

		// Send audio back to Twilio
		this.twilioWs.send(
			JSON.stringify({
				event: "media",
				streamSid: this.streamSid,
				media: {
					payload: Buffer.from(event.delta, "base64").toString("base64"),
				},
			}),
		);

		// Track playback timing for interruption handling
		if (this.responseStartTimestampTwilio === null) {
			this.responseStartTimestampTwilio = this.latestMediaTimestamp;
		}

		if (event.item_id) {
			this.lastAssistantItem = event.item_id;
		}

		// Send mark to track playback progress
		this.sendMark();

		// Forward AI audio to dashboard
		if (this.callSid) {
			this.broadcastDashboard({
				type: "ai_audio",
				callSid: this.callSid,
				payload: event.delta,
			});
		}
	}

	private sendMark() {
		if (!this.streamSid) return;

		const markEvent = {
			event: "mark",
			streamSid: this.streamSid,
			mark: { name: "responsePart" },
		};
		this.twilioWs.send(JSON.stringify(markEvent));
		this.markQueue.push("responsePart");
	}

	/** Handle interruption: patient starts speaking while AI is responding */
	private handleSpeechStarted() {
		if (
			this.markQueue.length > 0 &&
			this.responseStartTimestampTwilio != null
		) {
			const elapsedTime =
				this.latestMediaTimestamp - this.responseStartTimestampTwilio;

			// Tell OpenAI to truncate the current response
			if (this.lastAssistantItem) {
				this.openAIWs.send(
					JSON.stringify({
						type: "conversation.item.truncate",
						item_id: this.lastAssistantItem,
						content_index: 0,
						audio_end_ms: elapsedTime,
					}),
				);
			}

			// Tell Twilio to clear its audio buffer
			this.twilioWs.send(
				JSON.stringify({
					event: "clear",
					streamSid: this.streamSid,
				}),
			);

			// Reset tracking state
			this.markQueue = [];
			this.lastAssistantItem = null;
			this.responseStartTimestampTwilio = null;
		}
	}

	// ==================== Function Calling ====================

	private sendFunctionCallOutput(
		call_id: string,
		output: string,
		options?: { continueConversation?: boolean },
	) {
		this.openAIWs.send(
			JSON.stringify({
				type: "conversation.item.create",
				item: {
					type: "function_call_output",
					call_id,
					output,
				},
			}),
		);
		if (options?.continueConversation === false) return;
		this.openAIWs.send(JSON.stringify({ type: "response.create" }));
	}

	private scheduleTwilioHangup() {
		if (this.hangupScheduled) return;
		this.hangupScheduled = true;
		const delay = parseInt(process.env.END_CALL_DELAY_MS || "2500", 10);
		const callSid = this.callSid;
		const client = getTwilioRestClient();
		this.logger.info(
			{ callSid, delayMs: delay },
			"📴 Scheduling Twilio call completion",
		);
		setTimeout(() => {
			if (!callSid || !client) {
				this.hangupScheduled = false;
				return;
			}
			client
				.calls(callSid)
				.update({ status: "completed" })
				.then(() => {
					this.logger.info({ callSid }, "📴 Twilio call ended");
				})
				.catch((err: unknown) => {
					this.hangupScheduled = false;
					this.logger.error({ err, callSid }, "🔥 Failed to end Twilio call");
				});
		}, delay);
	}

	private async handleFunctionCall(event: {
		call_id: string;
		name?: string;
		arguments: string;
	}) {
		const { call_id, name, arguments: args } = event;

		if (!name) {
			console.log(
				"---------------------- TOOL SKIP (missing name) ----------------------",
			);
			console.log("call_id:", call_id, "callSid:", this.callSid);
			console.log(
				"-------------------------------------------------------------",
			);
			return;
		}
		if (args === undefined || args === null || args === "") {
			console.log(
				"---------------------- TOOL SKIP (missing args) ----------------------",
			);
			console.log("call_id:", call_id, "callSid:", this.callSid, "tool:", name);
			console.log(
				"-------------------------------------------------------------",
			);
			return;
		}

		let parsedArgs: unknown;
		try {
			parsedArgs = JSON.parse(args);
		} catch (parseErr) {
			console.log(
				"---------------------- TOOL INVALID JSON ----------------------",
			);
			console.log("tool:", name, "call_id:", call_id, "callSid:", this.callSid);
			console.log("args:", truncateForLog(args));
			console.log("parseError:", parseErr);
			console.log(
				"-------------------------------------------------------------",
			);
			if (this.callSid) {
				this.broadcastDashboard({
					type: "function_call",
					callSid: this.callSid,
					name,
					args,
					status: "error",
					result: "Invalid JSON in tool arguments",
				});
				this.persistEvent({
					type: "function_call",
					functionName: name,
					functionArgs: args,
					functionResult: "Invalid JSON in tool arguments",
					functionStatus: "error",
				});
			}
			this.sendFunctionCallOutput(
				call_id,
				JSON.stringify({
					error: true,
					message: `${name}: invalid JSON arguments`,
				}),
			);
			return;
		}

		console.log("---------------------- TOOL INVOKE ----------------------");
		console.log("callSid:", this.callSid, "call_id:", call_id, "tool:", name);
		console.log("input:", JSON.stringify(parsedArgs, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		if (this.callSid) {
			this.broadcastDashboard({
				type: "function_call",
				callSid: this.callSid,
				name,
				args,
				status: "calling",
			});
			this.persistEvent({
				type: "function_call",
				functionName: name,
				functionArgs: parsedArgs,
				functionStatus: "calling",
			});
		}

		try {
			let result: string;
			let scheduleHangupAfterOutput = false;

			switch (name) {
				case "get_specialities":
					result = this.getSpecialities();
					break;
				case "get_cities":
					result = this.getCities();
					break;
				case "search_location": {
					const args = parsedArgs as { city?: string; query?: string };
					if (!args.city || !args.query) {
						result = JSON.stringify({
							error: true,
							message:
								"search_location: invalid arguments (expected city and query)",
						});
						break;
					}
					result = await this.searchLocation(args.city, args.query);
					break;
				}
				case "end_call":
					if (!this.callSid) {
						result = JSON.stringify({
							error: true,
							message: "end_call: no active call",
						});
					} else if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
						result = JSON.stringify({
							error: true,
							message: "end_call: Twilio credentials not configured",
						});
					} else {
						scheduleHangupAfterOutput = true;
						result = JSON.stringify({
							success: true,
							message:
								"Hangup scheduled. Do not speak again; the call will disconnect shortly.",
						});
					}
					break;
				case "find_available_slots": {
					const slotArgs = normalizeFindAvailableSlotsArgs(parsedArgs);
					if (!slotArgs) {
						result = JSON.stringify({
							error: true,
							message:
								"find_available_slots: invalid arguments (expected speciality_slug, latitude, longitude, optional preferred_time)",
						});
						break;
					}
					result = await this.findAvailableSlots(slotArgs);
					break;
				}
				case "find_doctor_slots": {
					const doctorSlotArgs = normalizeFindDoctorSlotsArgs(parsedArgs);
					if (!doctorSlotArgs) {
						result = JSON.stringify({
							error: true,
							message:
								"find_doctor_slots: invalid arguments (expected doctor_id, optional preferred_time, optional limit)",
						});
						break;
					}
					result = await this.findDoctorSlots(doctorSlotArgs);
					break;
				}
				case "book_appointment": {
					const bookArgs = normalizeBookAppointmentArgs(parsedArgs);
					if (!bookArgs) {
						result = JSON.stringify({
							error: true,
							message:
								"book_appointment: invalid arguments (expected doctor_id, patient_name, illness, start, end)",
						});
						break;
					}
					result = await this.bookAppointment(bookArgs);
					break;
				}
				case "update_person_info": {
					const personArgs = normalizeUpdatePersonInfoArgs(parsedArgs);
					if (!personArgs) {
						result = JSON.stringify({
							error: true,
							message:
								"update_person_info: invalid arguments (expected at least one of first_name, last_name, date_of_birth, gender, address)",
						});
						break;
					}
					result = await this.updatePersonInfo(personArgs);
					break;
				}
				default:
					console.log(
						"---------------------- UNKNOWN TOOL ----------------------",
					);
					console.log("tool:", name, "call_id:", call_id, "input:", parsedArgs);
					console.log(
						"-------------------------------------------------------------",
					);
					result = JSON.stringify({ error: `Unknown function: ${name}` });
			}

			if (name === "get_specialities" || name === "get_cities") {
				console.log(
					"---------------------- TOOL SUCCESS ----------------------",
				);
				console.log(
					"tool:",
					name,
					"call_id:",
					call_id,
					"resultChars:",
					result.length,
				);
				console.log(
					"-------------------------------------------------------------",
				);
			} else {
				console.log(
					"---------------------- TOOL SUCCESS ----------------------",
				);
				console.log("tool:", name, "call_id:", call_id);
				console.log("input:", JSON.stringify(parsedArgs, null, 2));
				console.log("result:", truncateForLog(result));
				console.log(
					"-------------------------------------------------------------",
				);
			}

			if (this.callSid) {
				this.broadcastDashboard({
					type: "function_call",
					callSid: this.callSid,
					name,
					args,
					status: "success",
					result,
				});
				const parsedResult = (() => {
					try {
						return JSON.parse(result);
					} catch {
						return result;
					}
				})();
				this.persistEvent({
					type: "function_call",
					functionName: name,
					functionArgs: parsedArgs,
					functionResult: parsedResult,
					functionStatus: "success",
				});
			}

			this.sendFunctionCallOutput(call_id, result, {
				continueConversation: !scheduleHangupAfterOutput,
			});
			if (scheduleHangupAfterOutput) this.scheduleTwilioHangup();
		} catch (error: unknown) {
			consoleLogToolHttpError(
				name,
				{
					callSid: this.callSid,
					call_id,
					input: parsedArgs,
				},
				error,
			);

			const reason = toolFailureMessage(name, error);
			console.log(
				"---------------------- TOOL FAILED (summary) ----------------------",
			);
			console.log(reason);
			console.log(
				"-------------------------------------------------------------",
			);

			if (this.callSid) {
				this.broadcastDashboard({
					type: "function_call",
					callSid: this.callSid,
					name,
					args,
					status: "error",
					result: reason,
				});
				this.persistEvent({
					type: "function_call",
					functionName: name,
					functionArgs: parsedArgs,
					functionResult: reason,
					functionStatus: "error",
				});
			}

			this.sendFunctionCallOutput(
				call_id,
				JSON.stringify({
					error: true,
					message: reason,
				}),
			);
		}
	}

	private getSpecialities(): string {
		return JSON.stringify(
			SPECIALITIES.map(({ slug, en_name, fr_name, ar_name }) => ({
				slug,
				en_name,
				fr_name,
				ar_name,
			})),
		);
	}

	private getCities(): string {
		return JSON.stringify(
			CITIES.map(
				({ slug, latitude, longitude, en_name, fr_name, ar_name }) => ({
					slug,
					latitude,
					longitude,
					en_name,
					fr_name,
					ar_name,
				}),
			),
		);
	}

	private async searchLocation(city: string, query: string): Promise<string> {
		const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;
		if (!GEOAPIFY_API_KEY) {
			this.logger.error("GEOAPIFY_API_KEY is not set");
			return JSON.stringify({
				error: true,
				message: "Geocoding API key not configured.",
			});
		}
		try {
			const { data } = await axios.get(
				"https://api.geoapify.com/v1/geocode/search",
				{
					params: {
						text: `${query}, ${city}`,
						filter: "countrycode:tn",
						limit: 5,
						apiKey: GEOAPIFY_API_KEY,
					},
				},
			);
			const features = data.features || [];
			if (features.length === 0) {
				return JSON.stringify({
					found: false,
					message:
						"No results found. Please ask the patient for more context (e.g., region, city).",
				});
			}

			// biome-ignore lint/suspicious/noExplicitAny: geoapify structure
			const results = features.map((f: any) => ({
				name: f.properties.formatted,
				city: f.properties.city,
				state: f.properties.state,
				street: f.properties.street,
				latitude: f.properties.lat,
				longitude: f.properties.lon,
			}));

			return JSON.stringify({
				found: true,
				results,
				message:
					results.length > 1
						? "Multiple results found. Please ask the patient to clarify which one they mean by presenting the options."
						: "One result found. Proceed with this location.",
			});
		} catch (error) {
			this.logger.error({ error }, "Geocoding API error");
			return JSON.stringify({
				error: true,
				message: "Failed to search location.",
			});
		}
	}

	private async findAvailableSlots(params: {
		specialitySlug: string;
		latitude: number;
		longitude: number;
		preferredTime?: string;
	}): Promise<string> {
		const path = "/api/doctors/best-fit";
		// Next route expects query keys: speciality, lat, long, time
		const query = {
			speciality: params.specialitySlug,
			lat: params.latitude,
			long: params.longitude,
			time: params.preferredTime,
		};

		console.log(
			"---------------------- find_available_slots REQUEST ----------------------",
		);
		console.log("url:", nextjsApi.getUri({ url: path, params: query }));
		console.log("query:", JSON.stringify(query, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const { data } = await nextjsApi.get<BestFitDoctor[]>(path, {
			params: query,
		});

		if (!data || data.length === 0) {
			console.log(
				"---------------------- find_available_slots EMPTY ----------------------",
			);
			console.log("query:", JSON.stringify(query, null, 2));
			console.log("doctorCount:", data?.length ?? 0);
			console.log(
				"-------------------------------------------------------------",
			);
			return JSON.stringify({
				found: false,
				message:
					"No doctors with available slots were found for this speciality and location.",
			});
		}

		// Return top 3 for the AI (doctorId = doctorProfile.id for book_appointment)
		const top = data.slice(0, 3).map((doc) => ({
			doctorId: doc.id,
			name: `Dr. ${doc.firstName} ${doc.lastName}`,
			cabinet: doc.cabinetName,
			address: doc.address ?? null,
			distanceKm: Math.round(doc.distance * 10) / 10,
			slotStart: doc.nextSlot.start,
			slotEnd: doc.nextSlot.end,
		}));

		console.log(
			"---------------------- find_available_slots OK ----------------------",
		);
		console.log("totalMatches:", data.length, "returned:", top.length);
		console.log(
			"doctorIds:",
			top.map((d) => d.doctorId),
		);
		console.log("top:", JSON.stringify(top, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		return JSON.stringify({ found: true, doctors: top });
	}

	private async findDoctorSlots(params: {
		doctorId: number;
		preferredTime?: string;
		limit?: number;
	}): Promise<string> {
		const path = "/api/doctors/availability";
		const query = {
			doctor_id: params.doctorId,
			time: params.preferredTime,
			limit: params.limit,
		};

		console.log(
			"---------------------- find_doctor_slots REQUEST ----------------------",
		);
		console.log("url:", nextjsApi.getUri({ url: path, params: query }));
		console.log("query:", JSON.stringify(query, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const { data } = await nextjsApi.get<DoctorAvailabilityResponse>(path, {
			params: query,
		});

		const doctorName = `Dr. ${data.doctor.firstName} ${data.doctor.lastName}`;
		if (!data.found || data.slots.length === 0) {
			console.log(
				"---------------------- find_doctor_slots EMPTY ----------------------",
			);
			console.log("query:", JSON.stringify(query, null, 2));
			console.log("doctor:", doctorName, "doctorId:", data.doctor.id);
			console.log(
				"-------------------------------------------------------------",
			);
			return JSON.stringify({
				found: false,
				doctor: {
					doctorId: data.doctor.id,
					name: doctorName,
					cabinet: data.doctor.cabinetName,
					address: data.doctor.address ?? null,
				},
				message: "No available slots were found for this doctor.",
			});
		}

		const slots = data.slots.map((slot) => ({
			slotStart: slot.start,
			slotEnd: slot.end,
		}));

		console.log(
			"---------------------- find_doctor_slots OK ----------------------",
		);
		console.log("doctor:", doctorName, "doctorId:", data.doctor.id);
		console.log("returnedSlots:", slots.length);
		console.log("slots:", JSON.stringify(slots, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		return JSON.stringify({
			found: true,
			doctor: {
				doctorId: data.doctor.id,
				name: doctorName,
				cabinet: data.doctor.cabinetName,
				address: data.doctor.address ?? null,
			},
			slots,
		});
	}

	private async bookAppointment(
		params: BookAppointmentToolArgs,
	): Promise<string> {
		console.log(
			"---------------------- book_appointment INPUT ----------------------",
		);
		console.log(JSON.stringify(params, null, 2));
		console.log("callerPhone:", this.callerPhone);
		console.log(
			"-------------------------------------------------------------",
		);

		const callerRaw = this.callerPhone?.trim();
		if (!callerRaw) {
			const msg =
				"book_appointment: no caller phone on this call (Twilio From / callerPhone)";
			console.log(
				"---------------------- book_appointment VALIDATION ERROR ----------------------",
			);
			console.log(msg);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}
		const phoneNumber = phoneDigitsOnly(callerRaw);
		if (phoneNumber.length < 8) {
			const msg = `book_appointment: caller phone too short after normalization (${phoneNumber.length} digits)`;
			console.log(
				"---------------------- book_appointment VALIDATION ERROR ----------------------",
			);
			console.log("callerPhone:", callerRaw, "digits:", phoneNumber);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}

		const doctorId = Number(params.doctorId);
		if (
			!Number.isFinite(doctorId) ||
			doctorId <= 0 ||
			!Number.isInteger(doctorId)
		) {
			const msg = `Invalid doctorId: expected a positive integer (from find_available_slots doctorId), got ${JSON.stringify(params.doctorId)}`;
			console.log(
				"---------------------- book_appointment VALIDATION ERROR ----------------------",
			);
			console.log("params:", JSON.stringify(params, null, 2));
			console.log("doctorIdParsed:", doctorId);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}

		const body: BookAppointmentParams = {
			doctorId,
			name: params.patientName,
			phoneNumber,
			illness: params.illness,
			start: params.start,
			end: params.end,
		};

		const bookPath = "/api/appointments/external";
		console.log(
			"---------------------- book_appointment REQUEST ----------------------",
		);
		console.log("url:", `${nextjsApi.defaults.baseURL}${bookPath}`);
		console.log("body:", JSON.stringify(body, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const { data } = await nextjsApi.post(bookPath, body);

		console.log(
			"---------------------- book_appointment RESPONSE ----------------------",
		);
		console.log(data);
		console.log(
			"-------------------------------------------------------------",
		);

		// biome-ignore lint/suspicious/noExplicitAny: API row shape varies
		const row = data as any;
		const appointmentId = row?.id ?? row?._id;

		// Broadcast to dashboard
		if (this.callSid) {
			this.broadcastDashboard({
				type: "appointment_booked",
				callSid: this.callSid,
				data,
			});
			this.persistEvent({
				type: "appointment_booked",
				content: `Appointment #${appointmentId ?? "?"} booked`,
				functionResult: data,
			});
			this.persistCallUpdate({
				appointmentId: appointmentId ?? null,
				callerName: params.patientName,
			});
		}

		return JSON.stringify({
			success: true,
			appointment_id: appointmentId,
			status: row?.status,
			message: "Appointment created successfully with pending status.",
		});
	}

	private async updatePersonInfo(
		params: UpdatePersonInfoToolArgs,
	): Promise<string> {
		console.log(
			"---------------------- update_person_info INPUT ----------------------",
		);
		console.log(JSON.stringify(params, null, 2));
		console.log("personId:", this.personId);
		console.log(
			"-------------------------------------------------------------",
		);

		if (this.personId == null && this.callerPhone) {
			console.log(
				"---------------------- update_person_info AWAITING PERSON ----------------------",
			);
			console.log("callerPhone:", this.callerPhone);
			console.log(
				"-------------------------------------------------------------",
			);
			this.personId = await ensurePersonRow(this.callerPhone);
		}

		if (this.personId == null) {
			const msg =
				"update_person_info: no person record for this caller (ensurePersonRow may still be pending)";
			console.log(
				"---------------------- update_person_info VALIDATION ERROR ----------------------",
			);
			console.log(msg);
			console.log("callerPhone:", this.callerPhone);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}

		const path = `/api/persons/${this.personId}`;
		console.log(
			"---------------------- update_person_info REQUEST ----------------------",
		);
		console.log("url:", `${nextjsApi.defaults.baseURL}${path}`);
		console.log("body:", JSON.stringify(params, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const data = await updatePersonRow(this.personId, params);

		console.log(
			"---------------------- update_person_info RESPONSE ----------------------",
		);
		console.log(data);
		console.log(
			"-------------------------------------------------------------",
		);

		return JSON.stringify({
			success: true,
			person_id: data.id,
			message: "Person record updated successfully.",
		});
	}

	// ==================== DB Persistence Helpers ====================

	private async withCallId(
		fn: (callId: number) => Promise<void>,
	): Promise<void> {
		if (!this.dbCallIdPromise) return;
		try {
			const id = await this.dbCallIdPromise;
			if (id == null) return;
			await fn(id);
		} catch (err) {
			this.logger.error({ err }, "🔥 DB persistence error");
		}
	}

	private persistEvent(event: Parameters<typeof createCallEvent>[1]): void {
		void this.withCallId((id) => createCallEvent(id, event));
	}

	private persistCallUpdate(update: Parameters<typeof updateCall>[1]): void {
		void this.withCallId((id) => updateCall(id, update));
	}

	// ==================== Dashboard Broadcasting ====================

	private broadcastDashboard(message: DashboardMessage) {
		const json = JSON.stringify(message);
		this.dashboardClients.forEach((client) => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(json);
			}
		});
	}

	// ==================== Cleanup ====================

	dispose() {
		this.logger.info("🗑️ Disposing TwilioSession");

		if (this.openAIWs) {
			this.openAIWs.removeAllListeners();
			if (
				this.openAIWs.readyState !== WebSocket.CLOSED &&
				this.openAIWs.readyState !== WebSocket.CLOSING
			) {
				this.openAIWs.close();
			}
		}

		if (this.twilioWs) {
			this.twilioWs.removeAllListeners();
		}

		this.logger.info("🔴 TwilioSession disposed");
	}
}
