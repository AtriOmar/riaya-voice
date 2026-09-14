import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
	Browsers,
	DisconnectReason,
	fetchLatestBaileysVersion,
	useMultiFileAuthState,
	type WASocket,
} from "@whiskeysockets/baileys";
import { pino } from "pino";
import { toDataURL } from "qrcode";

export type WhatsappStatus =
	| { type: "qr"; data: string }
	| { type: "connected"; phone?: string }
	| { type: "disconnected"; reason?: string }
	| { type: "connecting" };

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL_MS = 3_000;
/**
 * How long (ms) after all UI clients disconnect (and no messages are sent)
 * before we tear down the Baileys socket to free memory.
 * Auth files are kept on disk so a reconnect is fast.
 */
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000; // 5 minutes

const silentLogger = pino({ level: "silent" });

export class WhatsappService extends EventEmitter {
	private readonly userId: string;
	private readonly authFolder: string;

	private sock: WASocket | null = null;
	private connected = false;
	private phone: string | undefined = undefined;
	private lastQr: string | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	/** Number of UI websocket clients currently watching this service. */
	private uiClientCount = 0;
	private logger = pino({
		level: process.env.LOG_LEVEL || "debug",
		transport: { target: "pino-pretty", options: { colorize: true } },
	});

	constructor(userId: string) {
		super();
		this.userId = userId;
		this.authFolder = path.resolve("./whatsapp-auth", userId);
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	async connect(): Promise<void> {
		this.resetReconnectState();
		this.logger.info(
			{ userId: this.userId },
			"[WhatsApp] Starting Baileys connection…",
		);
		await this.startSocket();
	}

	getStatus(): { connected: boolean; phone?: string } {
		return { connected: this.connected, phone: this.phone };
	}

	getLastQr(): string | null {
		return this.lastQr;
	}

	async sendMessage(phone: string, text: string): Promise<void> {
		if (!this.sock || !this.connected) {
			// Not connected — try to bring it up (auth files exist) then retry once
			this.logger.info(
				{ userId: this.userId },
				"[WhatsApp] Not connected, attempting reconnect before send…",
			);
			await this.connect();
			// Wait up to 15 s for connection to open
			await this.waitForConnection(15_000);
		}
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp is not connected");
		}
		const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
		await this.sock.sendMessage(jid, { text });
		this.logger.info({ userId: this.userId, jid }, "[WhatsApp] Message sent");
		// Reset idle timer after activity
		this.rescheduleIdleShutdown();
	}

	async sendDocument(
		phone: string,
		documentUrl: string,
		fileName?: string,
		caption?: string,
		mimetype?: string,
	): Promise<void> {
		if (!this.sock || !this.connected) {
			this.logger.info(
				{ userId: this.userId },
				"[WhatsApp] Not connected, attempting reconnect before send…",
			);
			await this.connect();
			await this.waitForConnection(15_000);
		}
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp is not connected");
		}
		const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
		await this.sock.sendMessage(jid, {
			document: { url: documentUrl },
			fileName: fileName,
			...(caption?.trim() ? { caption } : {}),
			mimetype: mimetype || "application/pdf",
		});
		this.logger.info(
			{ userId: this.userId, jid, fileName },
			"[WhatsApp] Document sent",
		);
		this.rescheduleIdleShutdown();
	}

	/** Call when a UI websocket client connects so we keep the socket alive. */
	addUiClient(): void {
		this.uiClientCount += 1;
		this.logger.debug(
			{ userId: this.userId, uiClientCount: this.uiClientCount },
			"[WhatsApp] UI client added",
		);
		this.clearIdleTimer();
	}

	/** Call when a UI websocket client disconnects. */
	removeUiClient(): void {
		this.uiClientCount = Math.max(0, this.uiClientCount - 1);
		this.logger.debug(
			{ userId: this.userId, uiClientCount: this.uiClientCount },
			"[WhatsApp] UI client removed",
		);
		if (this.uiClientCount === 0) {
			this.rescheduleIdleShutdown();
		}
	}

	/**
	 * Log out of WhatsApp, clear saved auth, and start a fresh connection
	 * so a new QR code can be scanned (e.g. to link a different account).
	 */
	async logout(): Promise<void> {
		this.logger.info({ userId: this.userId }, "[WhatsApp] Logging out…");
		this.resetReconnectState();
		this.clearIdleTimer();

		const sock = this.sock;
		// Detach first so the close handler cannot race with the fresh connect below
		// (e.g. wipe auth files that the new socket has started writing).
		this.sock = null;
		if (sock) {
			try {
				sock.ev.removeAllListeners("creds.update");
				sock.ev.removeAllListeners("connection.update");
				sock.ev.removeAllListeners("messages.upsert");
				await sock.logout();
			} catch (err) {
				this.logger.warn(
					{ userId: this.userId, err },
					"[WhatsApp] Error during sock.logout — ending socket and clearing auth locally",
				);
				try {
					await sock.end(undefined);
				} catch {}
			}
		}

		try {
			fs.rmSync(this.authFolder, { recursive: true, force: true });
		} catch (err) {
			this.logger.warn(
				{ userId: this.userId, err },
				"[WhatsApp] Failed to clear auth directory during logout",
			);
		}

		this.connected = false;
		this.phone = undefined;
		this.lastQr = null;
		this.emit("status", { type: "disconnected", reason: "logged_out" });

		// Bring up a new socket so the admin can scan a QR for another account
		await this.connect();
	}

	// ─── Idle / Shutdown ─────────────────────────────────────────────────────

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private rescheduleIdleShutdown(): void {
		this.clearIdleTimer();
		// Only shut down if no one is actively watching
		if (this.uiClientCount > 0) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			this.logger.info(
				{ userId: this.userId, idleMs: IDLE_SHUTDOWN_MS },
				"[WhatsApp] Idle timeout reached — destroying socket to free memory (auth files kept)",
			);
			void this.destroySocket();
			this.connected = false;
			this.phone = undefined;
			this.lastQr = null;
			this.emit("status", { type: "disconnected", reason: "idle_shutdown" });
		}, IDLE_SHUTDOWN_MS);
	}

	// ─── Reconnect helpers ────────────────────────────────────────────────────

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private resetReconnectState(): void {
		this.clearReconnectTimer();
		this.reconnectAttempts = 0;
	}

	private scheduleReconnect(reason: string): void {
		this.reconnectAttempts += 1;

		if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
			const message = `max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded: ${reason}`;
			this.logger.error(
				{ userId: this.userId, attempts: this.reconnectAttempts - 1, reason },
				"[WhatsApp] Giving up on reconnect",
			);
			this.emit("status", { type: "disconnected", reason: message });
			return;
		}

		this.logger.info(
			{
				userId: this.userId,
				attempt: this.reconnectAttempts,
				maxAttempts: MAX_RECONNECT_ATTEMPTS,
				intervalMs: RECONNECT_INTERVAL_MS,
				reason,
			},
			"[WhatsApp] Scheduling reconnect",
		);
		this.emit("status", { type: "connecting" });

		this.clearReconnectTimer();
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.startSocket();
		}, RECONNECT_INTERVAL_MS);
	}

	// ─── Socket lifecycle ─────────────────────────────────────────────────────

	/** End the current Baileys socket so a new one can own auth writes (avoids races / corrupt creds). */
	private async destroySocket(): Promise<void> {
		const sock = this.sock;
		if (!sock) return;
		this.sock = null;
		try {
			sock.ev.removeAllListeners("creds.update");
			sock.ev.removeAllListeners("connection.update");
			sock.ev.removeAllListeners("messages.upsert");
			await sock.end(undefined);
		} catch (err) {
			this.logger.warn(
				{ userId: this.userId, err },
				"[WhatsApp] Error while closing socket",
			);
		}
	}

	private async startSocket(): Promise<void> {
		// Always tear down first: reconnect used to stack sockets, both calling saveCreds → bad files.
		await this.destroySocket();

		const { version } = await fetchLatestBaileysVersion().catch(() => ({
			version: [2, 3000, 1015901307] as [number, number, number],
		}));

		const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

		this.sock = makeWASocket({
			version,
			auth: state,
			logger: silentLogger,
			printQRInTerminal: false,
			browser: Browsers.macOS("Riaya"),
			syncFullHistory: false,
			shouldSyncHistoryMessage: () => false,
		});

		this.sock.ev.on("creds.update", saveCreds);

		this.sock.ev.on("connection.update", async (update) => {
			const { connection, lastDisconnect, qr } = update;

			if (qr) {
				this.logger.info(
					{ userId: this.userId },
					"[WhatsApp] New QR code received",
				);
				try {
					const dataUrl = await toDataURL(qr);
					this.lastQr = dataUrl;
					this.connected = false;
					this.phone = undefined;
					const payload: WhatsappStatus = { type: "qr", data: dataUrl };
					this.emit("status", payload);
				} catch (err) {
					this.logger.error(
						{ userId: this.userId, err },
						"[WhatsApp] Failed to generate QR image",
					);
				}
			}

			if (connection === "open") {
				this.reconnectAttempts = 0;
				this.clearReconnectTimer();
				this.connected = true;
				this.lastQr = null;
				this.phone = this.sock?.user?.id?.split(":")[0];
				this.logger.info(
					{ userId: this.userId, phone: this.phone },
					"[WhatsApp] Connected",
				);
				const payload: WhatsappStatus = {
					type: "connected",
					phone: this.phone,
				};
				this.emit("status", payload);
				// If nobody is watching the config UI, start the idle timer immediately
				if (this.uiClientCount === 0) {
					this.rescheduleIdleShutdown();
				}
			}

			if (connection === "close") {
				this.connected = false;
				this.phone = undefined;
				this.lastQr = null;
				const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
				const reason =
					DisconnectReason[statusCode as DisconnectReason] ??
					String(statusCode);
				this.logger.warn(
					{ userId: this.userId, reason, statusCode },
					"[WhatsApp] Connection closed",
				);

				const isAuthFailure =
					statusCode === DisconnectReason.loggedOut ||
					statusCode === 405 ||
					statusCode === DisconnectReason.connectionReplaced;

				if (isAuthFailure) {
					this.logger.warn(
						{ userId: this.userId },
						"[WhatsApp] Auth failed/logged out. Clearing auth directory.",
					);
					try {
						fs.rmSync(this.authFolder, { recursive: true, force: true });
					} catch {}
				}

				const payload: WhatsappStatus = { type: "disconnected", reason };
				this.emit("status", payload);

				const shouldReconnect = !isAuthFailure;
				if (shouldReconnect) {
					this.scheduleReconnect(reason);
				} else {
					this.resetReconnectState();
					this.logger.warn(
						{ userId: this.userId },
						"[WhatsApp] Cleaned auth state - manual connect/reload required",
					);
				}
			}
		});

		this.sock.ev.on("messages.upsert", ({ messages, type }) => {
			if (type !== "notify") return;
			for (const msg of messages) {
				if (msg.key.fromMe) continue;
				const from = msg.key.remoteJid;
				const text =
					msg.message?.conversation ??
					msg.message?.extendedTextMessage?.text ??
					"[media / unsupported]";
				this.logger.info(
					{ userId: this.userId, from, text },
					"[WhatsApp] Incoming message",
				);
			}
		});
	}

	// ─── Utility ──────────────────────────────────────────────────────────────

	/** Waits for `connection === 'open'` or throws after `timeoutMs`. */
	private waitForConnection(timeoutMs: number): Promise<void> {
		if (this.connected) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.off("status", onStatus);
				reject(new Error("WhatsApp connection timeout"));
			}, timeoutMs);

			const onStatus = (payload: WhatsappStatus) => {
				if (payload.type === "connected") {
					clearTimeout(timer);
					this.off("status", onStatus);
					resolve();
				} else if (payload.type === "disconnected") {
					clearTimeout(timer);
					this.off("status", onStatus);
					reject(new Error(`WhatsApp disconnected: ${payload.reason}`));
				}
			};
			this.on("status", onStatus);
		});
	}
}
