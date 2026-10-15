import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { config } from "dotenv";
import Redis from "ioredis";
import { pino } from "pino";
import { nextjsApi } from "../api/nextjsApiClient.js";
import { getTwilioClient } from "../api/twilioClient.js";
import { ringTestCallInbox } from "../services/testCallInbox.js";
import { whatsappManager } from "../services/whatsappManager.js";
import type { CallbackReason } from "../sessions/callInstructions.js";

config();

const logger = pino({ name: "pendingTimeoutWorker" });

const connection = new Redis(
	process.env.REDIS_URL || "redis://localhost:6379",
	{
		maxRetriesPerRequest: null,
	},
);

const TWILIO_PHONE_NUMBER =
	process.env.TWILIO_PHONE_NUMBER?.trim() ||
	process.env.RIAYA_PHONE_NUMBER?.trim() ||
	"";

/**
 * `CALLBACK_TO_TEST_CALL_PAGE=true`: ring an open /test-call page instead of
 * dialing through Twilio. Anything else (default): always use Twilio.
 */
const CALLBACK_TO_TEST_CALL_PAGE =
	process.env.CALLBACK_TO_TEST_CALL_PAGE?.trim().toLowerCase() === "true";

/** Public https base of this server, for Twilio webhooks. Null if not configured. */
function publicBaseUrl(): string | null {
	const host = process.env.PUBLIC_SOCKET_HOST?.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/$/, "");
	return host ? `https://${host}` : null;
}

const FALLBACK_KEY_PREFIX = "pending-timeout:callback-fallback:";
const FALLBACK_TTL_SECONDS = 60 * 60;
/** Twilio terminal statuses where the patient never heard the message. */
const UNREACHED_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);

type FallbackPayload = {
	adminId: string | null;
	phone: string;
	message: string;
};

/**
 * Twilio `statusCallback` handler. The call id is an unguessable token stored
 * by `tryOutboundCall`; it is consumed here so the fallback fires at most once.
 */
export async function handleCallbackStatus(
	id: string,
	callStatus: string,
): Promise<void> {
	const key = `${FALLBACK_KEY_PREFIX}${id}`;
	const raw = await connection.get(key);
	if (!raw) return;
	if (!UNREACHED_STATUSES.has(callStatus)) {
		if (callStatus === "completed") await connection.del(key);
		return;
	}
	await connection.del(key);
	const payload = JSON.parse(raw) as FallbackPayload;
	logger.info(
		{ phone: payload.phone, callStatus },
		"[PendingTimeout] Callback not answered, sending WhatsApp fallback",
	);
	await sendWhatsappFallback(payload);
}

/**
 * Places a real call whose audio is handled by the voice server (`/incoming-call`
 * in callback mode), so the AI talks to the patient. Returns false when it
 * cannot place the call, and the caller falls back to WhatsApp.
 */
async function tryOutboundCall(params: {
	phone: string;
	reason: CallbackReason;
	fallback: FallbackPayload;
}): Promise<boolean> {
	const client = getTwilioClient();
	const baseUrl = publicBaseUrl();
	if (!client || !TWILIO_PHONE_NUMBER || !baseUrl) {
		logger.warn(
			{
				hasClient: Boolean(client),
				hasFromNumber: Boolean(TWILIO_PHONE_NUMBER),
				hasPublicHost: Boolean(baseUrl),
			},
			"[PendingTimeout] Outbound call skipped: Twilio or PUBLIC_SOCKET_HOST not configured",
		);
		return false;
	}
	try {
		// Unanswered / busy / failed calls report back so we can WhatsApp instead.
		const id = randomUUID();
		await connection.set(
			`${FALLBACK_KEY_PREFIX}${id}`,
			JSON.stringify(params.fallback),
			"EX",
			FALLBACK_TTL_SECONDS,
		);
		await client.calls.create({
			to: params.phone,
			from: TWILIO_PHONE_NUMBER,
			url: `${baseUrl}/incoming-call?mode=callback&reason=${params.reason}`,
			method: "POST",
			statusCallback: `${baseUrl}/twilio/callback-status?id=${id}`,
			statusCallbackMethod: "POST",
			statusCallbackEvent: ["completed"],
		});
		logger.info(
			{ phone: params.phone },
			"[PendingTimeout] Outbound call placed",
		);
		return true;
	} catch (err) {
		const e = err as {
			status?: number;
			code?: number;
			message?: string;
			moreInfo?: string;
		};
		logger.error(
			{
				twilioStatus: e.status,
				twilioCode: e.code,
				twilioMessage: e.message,
				moreInfo: e.moreInfo,
				to: params.phone,
				from: TWILIO_PHONE_NUMBER,
			},
			"[PendingTimeout] Outbound call failed",
		);
		return false;
	}
}

async function sendWhatsappFallback(params: {
	adminId: string | null;
	phone: string;
	message: string;
}): Promise<void> {
	// The admin dashboard links WhatsApp under the "admin" service id, not the
	// admin's user id. Prefer whichever candidate is already connected.
	const candidates = ["admin", params.adminId?.trim()].filter(
		(id): id is string => Boolean(id),
	);
	const userId =
		candidates.find(
			(id) => whatsappManager.getService(id).getStatus().connected,
		) ?? "admin";
	const waService = whatsappManager.getService(userId);
	logger.info(
		{ userId, connected: waService.getStatus().connected, phone: params.phone },
		"[PendingTimeout] Sending WhatsApp fallback",
	);
	// sendMessage reconnects from saved auth when the socket is down (e.g. after
	// a restart), so do not bail out early on `connected === false`.
	await waService.sendMessage(params.phone, params.message);
	logger.info(
		{ phone: params.phone, userId },
		"[PendingTimeout] WhatsApp fallback sent",
	);
}

export const pendingTimeoutWorker = new Worker(
	"pending-timeout-queue",
	async (job) => {
		logger.info({ data: job.data }, "[PendingTimeout] Processing job");

		const response = await nextjsApi.post(
			"/api/internal/appointments/process-pending-timeout",
			job.data,
			{
				headers: {
					"x-internal-secret": process.env.INTERNAL_API_SECRET ?? "",
				},
			},
		);

		const { success, reason, notified, phone, adminId, whatsappMessage } =
			response.data as {
				success: boolean;
				reason?: string;
				notified?: boolean;
				phone?: string;
				adminId?: string | null;
				whatsappMessage?: string;
			};

		if (!success) {
			logger.info({ reason }, "[PendingTimeout] Job skipped");
			return;
		}

		if (!notified || !phone || !whatsappMessage) {
			logger.info("[PendingTimeout] Cancelled with no patient notify");
			return;
		}

		const fallback: FallbackPayload = {
			adminId: adminId ?? null,
			phone,
			message: whatsappMessage,
		};

		// A /test-call page open for this number takes the call instead of Twilio.
		const callbackReason: CallbackReason =
			job.data?.kind === "refused" ? "refused" : "timeout";
		if (CALLBACK_TO_TEST_CALL_PAGE) {
			const outcome = await ringTestCallInbox(phone, {
				reason: callbackReason,
			});
			if (outcome === "answered") {
				logger.info({ phone }, "[PendingTimeout] Test-call page answered");
				return;
			}
			if (outcome) {
				logger.info(
					{ phone, outcome },
					"[PendingTimeout] Test-call page did not answer",
				);
				await sendWhatsappFallback(fallback);
				return;
			}
		}

		const called = await tryOutboundCall({
			phone,
			reason: callbackReason,
			fallback,
		});

		if (called) return;

		// Outbound call unavailable or failed → the written message goes on WhatsApp.
		await sendWhatsappFallback(fallback);
	},
	{ connection },
);

pendingTimeoutWorker.on("failed", (job, err) => {
	logger.error({ jobId: job?.id, err }, "[PendingTimeout] Job failed event");
});
