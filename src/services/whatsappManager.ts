import { pino } from "pino";
import { WhatsappService, type WhatsappStatus } from "./whatsappService.js";

const logger = pino({
	level: process.env.LOG_LEVEL || "debug",
	transport: { target: "pino-pretty", options: { colorize: true } },
});

/**
 * Registry of per-user WhatsappService instances.
 * Services are created lazily on first access and destroyed when idle
 * (the service itself handles idle shutdown internally).
 */
export class WhatsappManager {
	private services = new Map<string, WhatsappService>();

	/** Returns the existing service for a userId, or creates a new one. */
	getService(userId: string): WhatsappService {
		let service = this.services.get(userId);
		if (!service) {
			logger.info({ userId }, "[WhatsappManager] Creating new WhatsappService");
			service = new WhatsappService(userId);
			this.services.set(userId, service);
		}
		return service;
	}

	/** Forward a status listener to all clients watching a specific userId. */
	onStatus(userId: string, listener: (payload: WhatsappStatus) => void): void {
		this.getService(userId).on("status", listener);
	}

	offStatus(userId: string, listener: (payload: WhatsappStatus) => void): void {
		this.services.get(userId)?.off("status", listener);
	}
}

export const whatsappManager = new WhatsappManager();
