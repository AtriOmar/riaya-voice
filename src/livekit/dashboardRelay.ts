import type { Logger } from "pino";
import { WebSocket } from "ws";
import type { DashboardMessage } from "../types/index.js";

/**
 * Forwards dashboard events from the LiveKit agent process to the voice server,
 * which rebroadcasts them on `/dashboard` (the agent runs in a separate process
 * and has no access to the server's dashboard clients).
 */

const RELAY_URL =
	process.env.VOICE_EVENTS_URL?.trim() ||
	`ws://localhost:${process.env.PORT || 8080}/agent-events`;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";
const RECONNECT_DELAY_MS = 2000;
/** Events kept while disconnected; older ones are dropped. */
const MAX_QUEUE = 200;

export class DashboardRelay {
	private ws: WebSocket | null = null;
	private queue: string[] = [];
	private closed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly logger: Logger) {
		this.connect();
	}

	send(message: DashboardMessage) {
		const json = JSON.stringify(message);
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(json);
			return;
		}
		this.queue.push(json);
		if (this.queue.length > MAX_QUEUE) this.queue.shift();
	}

	close() {
		this.closed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.ws?.close();
	}

	private connect() {
		const ws = new WebSocket(RELAY_URL, {
			headers: { "x-internal-secret": INTERNAL_API_SECRET },
		});
		this.ws = ws;

		ws.on("open", () => {
			this.logger.info({ url: RELAY_URL }, "🟢 Dashboard relay connected");
			for (const json of this.queue) ws.send(json);
			this.queue = [];
		});
		ws.on("error", (error) =>
			this.logger.warn({ error: error.message }, "Dashboard relay error"),
		);
		ws.on("close", () => {
			if (this.closed) return;
			this.reconnectTimer = setTimeout(
				() => this.connect(),
				RECONNECT_DELAY_MS,
			);
		});
	}
}
