import { Worker } from "bullmq";
import { config } from "dotenv";
import Redis from "ioredis";
import { pino } from "pino";
import twilio from "twilio";
import { nextjsApi } from "../api/nextjsApiClient.js";
import { whatsappManager } from "../services/whatsappManager.js";

config();

const logger = pino({ name: "pendingTimeoutWorker" });

const connection = new Redis(
	process.env.REDIS_URL || "redis://localhost:6379",
	{
		maxRetriesPerRequest: null,
	},
);

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER =
	process.env.TWILIO_PHONE_NUMBER?.trim() ||
	process.env.RIAYA_PHONE_NUMBER?.trim() ||
	"";

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

async function tryOutboundCall(params: {
	phone: string;
	voiceScript: string;
	twilioLanguage: string;
}): Promise<boolean> {
	if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
		return false;
	}
	try {
		const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
		const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${escapeXml(params.twilioLanguage)}">${escapeXml(params.voiceScript)}</Say>
</Response>`;
		await client.calls.create({
			to: params.phone,
			from: TWILIO_PHONE_NUMBER,
			twiml,
		});
		logger.info({ phone: params.phone }, "[PendingTimeout] Outbound call placed");
		return true;
	} catch (err) {
		logger.error({ err }, "[PendingTimeout] Outbound call failed");
		return false;
	}
}

async function sendWhatsappFallback(params: {
	adminId: string | null;
	phone: string;
	message: string;
}): Promise<void> {
	const userId = params.adminId?.trim() || "admin";
	const waService = whatsappManager.getService(userId);
	const status = waService.getStatus();
	if (!status.connected) {
		throw new Error(`WhatsApp not connected for ${userId}`);
	}
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

		const {
			success,
			reason,
			notified,
			phone,
			adminId,
			whatsappMessage,
			voiceScript,
			twilioLanguage,
		} = response.data as {
			success: boolean;
			reason?: string;
			notified?: boolean;
			phone?: string;
			adminId?: string | null;
			whatsappMessage?: string;
			voiceScript?: string;
			twilioLanguage?: string;
		};

		if (!success) {
			logger.info({ reason }, "[PendingTimeout] Job skipped");
			return;
		}

		if (!notified || !phone || !whatsappMessage) {
			logger.info("[PendingTimeout] Cancelled with no patient notify");
			return;
		}

		const called =
			voiceScript && twilioLanguage
				? await tryOutboundCall({
						phone,
						voiceScript,
						twilioLanguage,
					})
				: false;

		if (called) return;

		// Outbound call unavailable or failed → ask the patient to call Riaya.
		await sendWhatsappFallback({
			adminId: adminId ?? null,
			phone,
			message: whatsappMessage,
		});
	},
	{ connection },
);

pendingTimeoutWorker.on("failed", (job, err) => {
	logger.error(
		{ jobId: job?.id, err },
		"[PendingTimeout] Job failed event",
	);
});
