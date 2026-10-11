import type { Logger } from "pino";
import twilio from "twilio";
import { type RawData, WebSocket } from "ws";
import { createCallEvent, ensureCallRow, updateCall } from "../api/callsApi.js";
import { ensurePersonRow } from "../api/personsApi.js";
import {
	createRealtimeProvider,
	type RealtimeFunctionCall,
	type RealtimeProvider,
} from "../realtime/index.js";
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
import {
	buildCallInstructions,
	buildInitialGreetingInstructions,
	type CallLanguage,
	normalizeCallLanguage,
} from "./callInstructions.js";

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

// ==================== TwilioSession ====================

export class TwilioSession {
	// Connection state
	private readonly provider: RealtimeProvider;
	private readonly tools: CallTools;
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

	constructor(
		private readonly twilioWs: WebSocket,
		private readonly logger: Logger,
		private readonly systemMessage: SystemMessage,
		private readonly dashboardClients: Set<WebSocket>,
	) {
		this.logger.info("🟢 TwilioSession created");
		this.tools = this.createTools();
		this.provider = createRealtimeProvider(this.logger, {
			onReady: () => {
				this.providerReady = true;
				this.trySendInitialGreeting();
			},
			onAudio: (payload, itemId) => this.handleAudioDelta(payload, itemId),
			onAiTranscriptDelta: (delta) => this.handleAiTranscriptDelta(delta),
			onAiTranscriptDone: (text) => this.handleAiTranscriptDone(text),
			onPatientTranscript: (text) => this.handlePatientTranscript(text),
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
		});
		this.initialize().catch((error) =>
			this.logger.error({ error }, "🔥 Failed to initialize TwilioSession"),
		);
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
		this.logger.info(`🔌 Realtime provider: ${this.provider.name}`);
		await this.provider.connect();
	}

	private buildSessionInstructions(): string {
		return buildCallInstructions(this.systemMessage.message, {
			language: this.callerPreferredLanguage,
			firstName: this.callerFirstName,
			callerPhone: this.callerPhone,
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
		this.provider.start(
			{
				instructions: this.buildSessionInstructions(),
				tools: this.systemMessage.tools,
				language: this.callerPreferredLanguage,
				firstName: this.callerFirstName,
			},
			buildInitialGreetingInstructions(
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
	}

	/** Refresh instructions after the session started (profile / language changed). */
	private sendSessionConfig() {
		if (!this.initialGreetingSent) return;
		this.provider.updateSession({
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
					this.callStartedAt = new Date();

					// Detect simulated browser calls so hangup closes the WS instead
					// of calling the Twilio REST API (which would fail on fake SIDs).
					this.isSimulated =
						params.simulated === "true" || this.callSid.startsWith("CA_SIM");

					// Ensure person exists (idempotent — /incoming-call likely already started this).
					if (this.callerPhone) {
						void ensurePersonRow(this.callerPhone).then((row) => {
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
					this.provider.sendAudio(msg.media.payload);

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
		if (
			this.markQueue.length > 0 &&
			this.responseStartTimestampTwilio != null
		) {
			const elapsedTime =
				this.latestMediaTimestamp - this.responseStartTimestampTwilio;

			// Tell the model how much of the reply the caller actually heard
			if (this.lastAssistantItem) {
				this.provider.truncate(this.lastAssistantItem, elapsedTime);
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

	private sendFunctionCallOutput(call: RealtimeFunctionCall, output: string) {
		this.provider.sendFunctionResult(call, output);
	}

	private onResponseDone() {
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

		try {
			let result: string;
			let scheduleHangupAfterOutput = false;

			switch (name) {
				case "end_call":
					if (!this.callSid) {
						result = JSON.stringify({
							error: true,
							message: "end_call: no active call",
						});
					} else if (
						!this.isSimulated &&
						(!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
					) {
						result = JSON.stringify({
							error: true,
							message: "end_call: Twilio credentials not configured",
						});
					} else {
						scheduleHangupAfterOutput = true;
						const lang = normalizeCallLanguage(
							(parsedArgs as { language?: string }).language,
						);
						const langHint =
							lang === "fr"
								? "French"
								: lang === "en"
									? "English"
									: "Tunisian Arabic (Derja)";
						result = JSON.stringify({
							success: true,
							message: `Call disconnect is scheduled when this response finishes. Say a brief thank-you and goodbye to the patient now (one short sentence, ${langHint}). Do not call other tools.`,
						});
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
				// Set before sending the result so the goodbye audio is recognised.
				this.pendingHangup = true;
				this.goodbyeAudioStarted = false;
				this.provider.enterClosingMode();
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
		this.clearHangupTimers();

		this.provider.close();

		if (this.twilioWs) {
			this.twilioWs.removeAllListeners();
		}

		this.logger.info("🔴 TwilioSession disposed");
	}
}
