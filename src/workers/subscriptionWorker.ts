// ─── Subscription Worker ──────────────────────────────────────────────────────
// Processes jobs from the "subscription-queue".
// The web project seeds a daily repeatable job (via instrumentation.ts) that
// this worker picks up and forwards to Next.js for processing.

import { Worker } from "bullmq";
import { config } from "dotenv";
import Redis from "ioredis";
import { pino } from "pino";
import { nextjsApi } from "../api/nextjsApiClient.js";

config();

const logger = pino({ name: "subscriptionWorker" });

const connection = new Redis(
	process.env.REDIS_URL || "redis://localhost:6379",
	{
		maxRetriesPerRequest: null,
	},
);

export const subscriptionWorker = new Worker(
	"subscription-queue",
	async (job) => {
		logger.info({ jobId: job.id, name: job.name }, "[SubscriptionWorker] Processing job");

		if (job.name === "check-expiring") {
			const response = await nextjsApi.post(
				"/api/internal/subscriptions/process-expiring",
				{},
				{
					headers: {
						"x-internal-secret": process.env.INTERNAL_API_SECRET ?? "",
					},
				},
			);

			logger.info(
				{ processed: response.data?.processed, results: response.data?.results },
				"[SubscriptionWorker] Expiring subscriptions processed",
			);
		} else {
			logger.warn({ name: job.name }, "[SubscriptionWorker] Unknown job name — skipping");
		}
	},
	{ connection },
);

subscriptionWorker.on("failed", (job, err) => {
	logger.error({ jobId: job?.id, err }, "[SubscriptionWorker] Job failed");
});

subscriptionWorker.on("completed", (job) => {
	logger.info({ jobId: job.id }, "[SubscriptionWorker] Job completed");
});
