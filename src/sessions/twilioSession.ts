import type { Logger } from "pino";
import { type RawData, WebSocket } from "ws";
import {
	type CallerRefusalContext,
	getCallerRefusalContext,
} from "../api/callerAppointmentsApi.js";
import {
	getPeopleOnLine,
	ownerOnly,
	type PersonOnLine,
} from "../api/callerPeopleApi.js";
import { createCallEvent, ensureCallRow, updateCall } from "../api/callsApi.js";
import { ensurePersonRow } from "../api/personsApi.js";
import { getTwilioClient } from "../api/twilioClient.js";
import {
	createRealtimeProvider,
	type RealtimeFunctionCall,
	type RealtimeProvider,
} from "../realtime/index.js";
import type { RealtimeHandlers } from "../realtime/types.js";
import {
	type CallSettings,
	loadCallSettings,
} from "../settings/callSettings.js";
import {
	CallTools,
	consoleLogToolHttpError,
	toolFailureMessage,
	truncateForLog,
} from "../tools/callTools.js";
import type {
	DashboardMessage,
	SystemMessage,
	TwilioMediaMessage,
} from "../types/index.js";
import { CallerTranscriber } from "./callerTranscriber.js";
import {
	buildCallbackGreetingInstructions,
	buildCallInstructions,
	buildHangupToolResult,
	buildInitialGreetingInstructions,
	buildWatchdogInstructions,
	type CallbackReason,
	type CallLanguage,
	normalizeCallbackReason,
	normalizeCallLanguage,
	type WatchdogPrompt,
} from "./callInstructions.js";
import { CallerVoiceDetector, CallWatchdog } from "./callWatchdog.js";

function getTwilioRestClient() {
	return getTwilioClient();
}

// ==================== TwilioSession ====================

export class TwilioSession {
	// Connection state
	private provider: RealtimeProvider | null = null;
	private readonly tools: CallTools;
	/** Ends silent calls and caps call length. */
	private readonly watchdog: CallWatchdog;
	private readonly voiceDetector = new CallerVoiceDetector(() =>
		this.watchdog.callerSpoke(),
	);
	/** Separate caller transcription; null when CALLER_STT=off (use the realtime model's transcript). */
	private callerTranscriber: CallerTranscriber | null = null;
	/** Provider connection is open and can accept `start()`. */
	private providerReady = false;
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
	/** Alternatives to offer when a doctor refused this caller's last request. */
	private refusalContext: CallerRefusalContext | null = null;
	/** Everyone on the caller's phone, for "who is this appointment for?". */
	private peopleOnLine: PersonOnLine[] = [];

	/** DB id of the person record for this caller (set once callerPhone is known). */
	private personId: number | null = null;

	/** Session has been started (config + opening greeting sent) */
	private initialGreetingSent = false;
	/** Twilio media `start` received — callerPhone / person lookup may still be in flight. */
	private twilioStreamStarted = false;
	/** Loaded from person row (or default ar) before first greeting when possible. */
	private personProfileResolved = false;
	/** Saved preference + active call language (default Arabic). */
	private callerPreferredLanguage: CallLanguage = "ar";
	private callerFirstName: string | null = null;

	/** Next.js DB row id for this call (available once ensureCallRow resolves). */
	private dbCallIdPromise: Promise<number | null> | null = null;
	private callStartedAt: Date | null = null;

	/** Avoid stacking multiple Twilio REST hangups for one session. */
	private hangupScheduled = false;
	/** `end_call` was invoked; hang up after the assistant goodbye response finishes. */
	private pendingHangup = false;
	/**
	 * AI audio arrived after the `end_call` result was sent, i.e. the goodbye is
	 * being spoken. The response that merely invoked `end_call` (no audio after
	 * the result) must not trigger the hangup.
	 */
	private goodbyeAudioStarted = false;
	/** Goodbye audio has finished generating; hang up once Twilio marks drain. */
	private hangupAfterPlayback = false;
	private hangupTimer: ReturnType<typeof setTimeout> | null = null;
	private fallbackHangupTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * True when the call originates from the browser test-call page rather than
	 * a real Twilio call.  Set from `customParameters.simulated === "true"` or a
	 * `CA_SIM*` callSid prefix.  Affects hangup: closes the WS instead of the
	 * Twilio REST API.
	 */
	private isSimulated = false;

	/** Set when Riaya placed the call (real Twilio callback or test-call page). */
	private callbackReason: CallbackReason | null = null;

	constructor(
		private readonly twilioWs: WebSocket,
		private readonly logger: Logger,
		private readonly systemMessage: SystemMessage,
		private readonly dashboardClients: Set<WebSocket>,
		/** Test-call page only: call id whose per-call model settings live in Redis. */
		private readonly settingsSid: string | null = null,
	) {
		this.logger.info("🟢 TwilioSession created");
		this.tools = this.createTools();
		this.watchdog = new CallWatchdog(this.logger, {
			onAskStillThere: () => this.promptAssistant("still_there"),
			onSilentGoodbye: () =>
				this.endWithGoodbye(
					"silent_goodbye",
					"Call ended: the caller stayed silent.",
				),
			onTimeLimit: () =>
				this.endWithGoodbye(
					"time_limit_goodbye",
					"Call ended: the call time limit was reached.",
				),
		});
		this.initialize().catch((error) =>
			this.logger.error({ error }, "🔥 Failed to initialize TwilioSession"),
		);
	}

	private realtimeHandlers(): RealtimeHandlers {
		return {
			onReady: () => {
				this.providerReady = true;
				this.trySendInitialGreeting();
			},
			onAudio: (payload, itemId) => this.handleAudioDelta(payload, itemId),
			onAiTranscriptDelta: (delta) => this.handleAiTranscriptDelta(delta),
			onAiTranscriptDone: (text) => this.handleAiTranscriptDone(text),
			onPatientTranscript: (text) => {
				// With a separate transcriber, the realtime model's own transcript is skipped.
				if (!this.callerTranscriber) this.handlePatientTranscript(text);
			},
			onSpeechStarted: () => this.handleSpeechStarted(),
			onFunctionCall: (call) => {
				void this.handleFunctionCall(call);
			},
			onResponseDone: () => {
				this.logger.debug("✅ Response complete");
				this.onResponseDone();
			},
			onError: (message, detail) => this.handleProviderError(message, detail),
			onClose: () => this.dispose(),
		};
	}

	private createCallerTranscriber(
		override?: NonNullable<CallSettings["phone"]>["callerStt"],
	): CallerTranscriber | null {
		if (override?.api === "off") return null;
		const mode = override
			? override.api === "openrouter-chat"
				? "openrouter-chat"
				: "openrouter"
			: process.env.CALLER_STT?.trim().toLowerCase();
		if (mode !== "openrouter" && mode !== "openrouter-chat") return null;
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			this.logger.warn(
				"CALLER_STT=openrouter but OPENROUTER_API_KEY is not set; using the realtime model's transcript",
			);
			return null;
		}
		const model =
			override?.model ||
			process.env.CALLER_STT_MODEL?.trim() ||
			"google/gemini-3.5-transcribe";
		this.logger.info({ model }, "🎙️ Separate caller transcription enabled");
		return new CallerTranscriber({
			logger: this.logger,
			apiKey,
			model,
			api: mode === "openrouter-chat" ? "chat" : "transcription",
			reasoningEffort:
				(override?.reasoning ?? process.env.GEMINI_STT_REASONING?.trim()) ===
				"none"
					? "none"
					: "minimal",
			onTranscript: (text) => this.handlePatientTranscript(text),
		});
	}

	private createTools(): CallTools {
		const session = this;
		return new CallTools({
			logger: this.logger,
			get callSid() {
				return session.callSid;
			},
			get callerPhone() {
				return session.callerPhone;
			},
			get personId() {
				return session.personId;
			},
			applyPersonRow: (row) => this.applyPersonRow(row),
			onProfileChange: ({ firstName, preferredLanguage }) => {
				if (firstName) this.callerFirstName = firstName;
				if (preferredLanguage) this.callerPreferredLanguage = preferredLanguage;
				this.sendSessionConfig();
			},
			emit: (message) => this.broadcastDashboard(message),
			persistEvent: (event) => this.persistEvent(event),
			persistCallUpdate: (update) => this.persistCallUpdate(update),
		});
	}

	// ==================== Initialization ====================

	private async initialize() {
		// Set up Twilio handlers FIRST so we don't miss early events (start, connected)
		// that Twilio sends immediately after the WebSocket is established
		this.setupTwilioHandlers();
		const settings = await loadCallSettings(this.settingsSid, this.logger);
		this.callerTranscriber = this.createCallerTranscriber(
			settings?.phone?.callerStt,
		);
		const realtime = settings?.phone?.realtime;
		const provider = createRealtimeProvider(
			this.logger,
			this.realtimeHandlers(),
			realtime
				? {
						backend: realtime.backend,
						model: realtime.model,
						voice: realtime.voice,
					}
				: undefined,
		);
		this.provider = provider;
		this.logger.info(`🔌 Realtime provider: ${provider.name}`);
		await provider.connect();
	}

	private buildSessionInstructions(): string {
		return buildCallInstructions(this.systemMessage.message, {
			language: this.callerPreferredLanguage,
			firstName: this.callerFirstName,
			callerPhone: this.callerPhone,
			people: this.peopleOnLine,
			refusalContext: this.refusalContext,
			callbackReason: this.callbackReason,
		});
	}

	private applyPersonRow(row: {
		id: number;
		firstName?: string | null;
		lastName?: string | null;
		preferredLanguage?: string | null;
	}) {
		this.personId = row.id;
		this.callerFirstName = row.firstName?.trim() || null;
		this.callerPreferredLanguage = normalizeCallLanguage(row.preferredLanguage);
		this.personProfileResolved = true;
		this.logger.info(
			{
				personId: row.id,
				preferredLanguage: this.callerPreferredLanguage,
				hasFirstName: Boolean(this.callerFirstName),
			},
			"👤 Person profile applied",
		);
	}

	private markPersonProfileResolvedWithoutRow() {
		this.personProfileResolved = true;
	}

	private trySendInitialGreeting() {
		if (this.initialGreetingSent) return;
		if (!this.providerReady) return;
		// The provider is often ready before Twilio `start`; wait so we can load name/lang.
		if (!this.twilioStreamStarted) return;
		if (!this.personProfileResolved) return;

		this.initialGreetingSent = true;
		this.provider?.start(
			{
				instructions: this.buildSessionInstructions(),
				tools: this.systemMessage.tools,
				language: this.callerPreferredLanguage,
				firstName: this.callerFirstName,
			},
			this.callbackReason
				? buildCallbackGreetingInstructions({
						lang: this.callerPreferredLanguage,
						firstName: this.callerFirstName,
						reason: this.callbackReason,
						refusedDoctorName: this.refusalContext?.refusedDoctorName,
					})
				: buildInitialGreetingInstructions(
						this.callerPreferredLanguage,
						this.callerFirstName,
					),
		);
		this.logger.info(
			{
				language: this.callerPreferredLanguage,
				hasCallerPhone: Boolean(this.callerPhone),
			},
			"🗣️ Session started, initial greeting triggered",
		);
		this.watchdog.start();
	}

	/** Refresh instructions after the session started (profile / language changed). */
	private sendSessionConfig() {
		if (!this.initialGreetingSent) return;
		this.provider?.updateSession({
			instructions: this.buildSessionInstructions(),
			tools: this.systemMessage.tools,
			language: this.callerPreferredLanguage,
			firstName: this.callerFirstName,
		});
	}

	// ==================== Realtime Provider Event Handlers ====================

	private handleAiTranscriptDelta(delta: string) {
		if (!this.callSid) return;
		this.currentAiTranscript += delta;
		this.broadcastDashboard({
			type: "ai_transcript",
			callSid: this.callSid,
			text: this.currentAiTranscript,
			delta,
			isFinal: false,
		});
	}

	private handleAiTranscriptDone(transcript: string) {
		if (!this.callSid) return;
		const finalText = transcript || this.currentAiTranscript;
		this.broadcastDashboard({
			type: "ai_transcript",
			callSid: this.callSid,
			text: finalText,
			delta: "",
			isFinal: true,
		});
		if (finalText) {
			this.persistEvent({ type: "ai_transcript", content: finalText });
		}
		this.currentAiTranscript = "";
	}

	private handlePatientTranscript(transcript: string) {
		this.watchdog.callerSpoke();
		if (!this.callSid) return;
		this.logger.info({ transcript }, "📝 Patient said");
		this.broadcastDashboard({
			type: "patient_transcript",
			callSid: this.callSid,
			text: transcript,
			isFinal: true,
		});
		this.persistEvent({ type: "patient_transcript", content: transcript });
	}

	private handleProviderError(message: string, detail?: unknown) {
		this.logger.error({ error: detail, message }, "🔥 Realtime provider error");
		if (!this.callSid) return;
		this.broadcastDashboard({ type: "error", callSid: this.callSid, message });
		this.persistEvent({ type: "error", content: message });
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
					this.twilioStreamStarted = true;
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
					this.callbackReason =
						params.callMode === "callback"
							? normalizeCallbackReason(params.callbackReason)
							: null;
					this.callStartedAt = new Date();

					// Detect simulated browser calls so hangup closes the WS instead
					// of calling the Twilio REST API (which would fail on fake SIDs).
					this.isSimulated =
						params.simulated === "true" || this.callSid.startsWith("CA_SIM");

					// Ensure person exists (idempotent — /incoming-call likely already started this).
					if (this.callerPhone) {
						void Promise.all([
							ensurePersonRow(this.callerPhone),
							getCallerRefusalContext(this.callerPhone),
							getPeopleOnLine(this.callerPhone),
						]).then(([row, refusalContext, people]) => {
							this.refusalContext = refusalContext;
							this.peopleOnLine =
								people.length > 0 ? people : row ? ownerOnly(row) : [];
							if (row != null) {
								this.applyPersonRow(row);
								this.sendSessionConfig();
							} else {
								this.markPersonProfileResolvedWithoutRow();
							}
							this.trySendInitialGreeting();
						});
					} else {
						this.markPersonProfileResolvedWithoutRow();
						this.trySendInitialGreeting();
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

					this.trySendInitialGreeting();
					break;
				}

				case "media":
					this.latestMediaTimestamp = parseInt(msg.media.timestamp, 10);

					// Forward audio to the realtime model
					this.provider?.sendAudio(msg.media.payload);
					this.callerTranscriber?.push(msg.media.payload);
					this.voiceDetector.push(msg.media.payload);

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
					// Playback drained: the caller has heard everything said so far.
					if (this.markQueue.length === 0) {
						this.watchdog.setAssistantSpeaking(false);
					}
					this.tryScheduleHangupAfterPlayback();
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

	private handleAudioDelta(payload: string, itemId?: string) {
		if (!payload || !this.streamSid) return;
		if (this.pendingHangup) this.goodbyeAudioStarted = true;
		this.watchdog.setAssistantSpeaking(true);

		// Send audio back to Twilio
		this.twilioWs.send(
			JSON.stringify({
				event: "media",
				streamSid: this.streamSid,
				media: {
					payload,
				},
			}),
		);

		if (this.responseStartTimestampTwilio === null) {
			this.responseStartTimestampTwilio = this.latestMediaTimestamp;
		}

		if (itemId) {
			this.lastAssistantItem = itemId;
		}

		// Send mark to track playback progress
		this.sendMark();

		// Forward AI audio to dashboard
		if (this.callSid) {
			this.broadcastDashboard({
				type: "ai_audio",
				callSid: this.callSid,
				payload,
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
		if (this.pendingHangup) return;
		this.watchdog.callerSpoke();
		if (
			this.markQueue.length > 0 &&
			this.responseStartTimestampTwilio != null
		) {
			const elapsedTime =
				this.latestMediaTimestamp - this.responseStartTimestampTwilio;

			// Tell the model how much of the reply the caller actually heard
			if (this.lastAssistantItem) {
				this.provider?.truncate(this.lastAssistantItem, elapsedTime);
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

	// ==================== Watchdog (silence / time limit) ====================

	private promptAssistant(prompt: WatchdogPrompt) {
		this.provider?.prompt(
			buildWatchdogInstructions(prompt, this.callerPreferredLanguage),
		);
	}

	/** Say one goodbye line, then hang up the same way `end_call` does. */
	private endWithGoodbye(prompt: WatchdogPrompt, note: string) {
		if (this.pendingHangup || this.hangupScheduled) return;
		this.logger.info(
			{ callSid: this.callSid, prompt },
			"📴 Watchdog ending call",
		);
		this.persistEvent({ type: "system", content: note });
		this.pendingHangup = true;
		this.goodbyeAudioStarted = false;
		this.promptAssistant(prompt);
		this.provider?.enterClosingMode();
		this.scheduleFallbackHangup();
	}

	// ==================== Function Calling ====================

	private sendFunctionCallOutput(call: RealtimeFunctionCall, output: string) {
		this.provider?.sendFunctionResult(call, output);
	}

	private onResponseDone() {
		if (this.markQueue.length === 0) this.watchdog.setAssistantSpeaking(false);
		// Hang up only after the goodbye turn, not the turn that called `end_call`.
		if (this.pendingHangup && this.goodbyeAudioStarted) {
			this.hangupAfterPlayback = true;
			this.tryScheduleHangupAfterPlayback();
		}
	}

	private tryScheduleHangupAfterPlayback() {
		if (!this.hangupAfterPlayback || this.hangupScheduled) return;
		if (this.markQueue.length > 0) return;
		const delay = parseInt(process.env.END_CALL_DELAY_MS || "800", 10);
		this.scheduleTwilioHangup(delay);
	}

	private scheduleFallbackHangup() {
		if (this.fallbackHangupTimer) return;
		const maxWait = parseInt(process.env.END_CALL_MAX_WAIT_MS || "12000", 10);
		this.fallbackHangupTimer = setTimeout(() => {
			this.fallbackHangupTimer = null;
			this.logger.warn(
				{ callSid: this.callSid },
				"📴 Fallback hangup after closing wait",
			);
			this.scheduleTwilioHangup(0);
		}, maxWait);
	}

	private clearHangupTimers() {
		if (this.hangupTimer) {
			clearTimeout(this.hangupTimer);
			this.hangupTimer = null;
		}
		if (this.fallbackHangupTimer) {
			clearTimeout(this.fallbackHangupTimer);
			this.fallbackHangupTimer = null;
		}
	}

	private scheduleTwilioHangup(delayMs?: number) {
		if (this.hangupScheduled) return;
		this.hangupScheduled = true;
		this.clearHangupTimers();
		const delay =
			delayMs ?? parseInt(process.env.END_CALL_DELAY_MS || "800", 10);
		const callSid = this.callSid;

		this.logger.info(
			{ callSid, delayMs: delay, simulated: this.isSimulated },
			"📴 Scheduling call hangup",
		);
		this.hangupTimer = setTimeout(() => {
			this.hangupTimer = null;
			this.executeHangup(callSid);
		}, delay);
	}

	private executeHangup(callSid: string | null) {
		if (this.isSimulated) {
			this.logger.info({ callSid }, "📴 Closing simulated call WebSocket");
			try {
				this.twilioWs.close();
			} catch {
				// already closed
			}
			return;
		}

		const client = getTwilioRestClient();
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
				try {
					this.twilioWs.close();
				} catch {
					// already closed
				}
			});
	}

	private async handleFunctionCall(call: RealtimeFunctionCall) {
		const { callId: call_id, name, args } = call;

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
				call,
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

		this.watchdog.toolStarted();
		try {
			let result: string;
			let scheduleHangupAfterOutput = false;

			switch (name) {
				case "end_call":
				case "report_abuse":
					// Report first so the admins get it even if the hangup fails below.
					if (name === "report_abuse") {
						await this.tools.run(name, parsedArgs, call_id);
					}
					if (!this.callSid) {
						result = JSON.stringify({
							error: true,
							message: `${name}: no active call`,
						});
					} else if (!this.isSimulated && !getTwilioRestClient()) {
						result = JSON.stringify({
							error: true,
							message: `${name}: Twilio credentials not configured`,
						});
					} else {
						scheduleHangupAfterOutput = true;
						result = buildHangupToolResult(
							normalizeCallLanguage(
								(parsedArgs as { language?: string }).language,
							),
							name === "report_abuse" ? "abuse" : "done",
						);
					}
					break;
				default:
					result = await this.tools.run(name, parsedArgs, call_id);
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

			if (scheduleHangupAfterOutput) {
				this.watchdog.stop();
				// Set before sending the result so the goodbye audio is recognised.
				this.pendingHangup = true;
				this.goodbyeAudioStarted = false;
				this.provider?.enterClosingMode();
				this.scheduleFallbackHangup();
			}

			this.sendFunctionCallOutput(call, result);
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
				call,
				JSON.stringify({
					error: true,
					message: reason,
				}),
			);
		} finally {
			this.watchdog.toolFinished();
		}
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
		this.watchdog.stop();
		this.clearHangupTimers();
		this.callerTranscriber?.close();

		this.provider?.close();

		if (this.twilioWs) {
			this.twilioWs.removeAllListeners();
		}

		this.logger.info("🔴 TwilioSession disposed");
	}
}
