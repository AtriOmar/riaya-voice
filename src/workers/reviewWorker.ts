import { Worker } from "bullmq";
import { config } from "dotenv";
import Redis from "ioredis";
import { pino } from "pino";
import { nextjsApi } from "../api/nextjsApiClient.js";
import { whatsappManager } from "../services/whatsappManager.js";

config();

const logger = pino({ name: "reviewWorker" });

const connection = new Redis(
	process.env.REDIS_URL || "redis://localhost:6379",
	{
		maxRetriesPerRequest: null,
	},
);
const APP_URL = process.env.NEXTJS_API_URL || "http://localhost:3000";

export const reviewWorker = new Worker(
	"review-queue",
	async (job) => {
		const { appointmentId, doctorId, patientId } = job.data;
		logger.info(
			{ appointmentId, doctorId, patientId },
			"[ReviewWorker] Processing job",
		);

		try {
			// Call internal Next.js API to verify and create the review
			const response = await nextjsApi.post(
				"/api/internal/reviews/process-job",
				{
					appointmentId,
					doctorId,
					patientId,
				},
			);

			const {
				success,
				reason,
				token,
				phone,
				patientName,
				doctorName,
				adminId,
			} = response.data;

			if (!success) {
				logger.info({ reason }, "[ReviewWorker] Job skipped");
				return;
			}

			if (!adminId) {
				logger.error("[ReviewWorker] Missing adminId, cannot send message");
				return;
			}

			// Get the Whatsapp service for this doctor/admin
			const waService = whatsappManager.getService(adminId);
			const status = waService.getStatus();

			if (!status.connected) {
				logger.error({ status }, "[ReviewWorker] WhatsApp not connected");
				// Throw error so BullMQ retries later
				throw new Error("WhatsApp not connected");
			}

			// Consume monthly WhatsApp quota (skip send if Free plan limit hit)
			try {
				await nextjsApi.post(
					"/api/internal/billing/consume-whatsapp",
					{ userId: adminId, count: 1 },
					{
						headers: {
							"x-internal-secret": process.env.INTERNAL_API_SECRET ?? "",
						},
					},
				);
			} catch (quotaErr: unknown) {
				const ax = quotaErr as {
					response?: { data?: { error?: string } };
				};
				if (ax.response?.data?.error === "WHATSAPP_LIMIT_REACHED") {
					logger.info(
						{ appointmentId, adminId },
						"[ReviewWorker] WhatsApp limit reached — skipping review message",
					);
					return;
				}
				throw quotaErr;
			}

			const link = `${APP_URL}/review/${token}`;
			const message = `Hi ${patientName}, thanks for visiting ${doctorName}. Please take 30 seconds to answer 3 quick questions about your visit:\n\n${link}`;

			await waService.sendMessage(phone, message);
			logger.info(
				{ phone, appointmentId },
				"[ReviewWorker] Review message sent",
			);
		} catch (error) {
			logger.error({ error }, "[ReviewWorker] Job failed");
			throw error;
		}
	},
	{ connection },
);

reviewWorker.on("failed", (job, err) => {
	logger.error({ jobId: job?.id, err }, "[ReviewWorker] Job failed event");
});
