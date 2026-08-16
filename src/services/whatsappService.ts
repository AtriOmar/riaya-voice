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

const AUTH_FOLDER = path.resolve("./whatsapp-auth/admin");

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL_MS = 3_000;

const silentLogger = pino({ level: "silent" });

export class WhatsappService extends EventEmitter {
	private sock: WASocket | null = null;
	private connected = false;
	private phone: string | undefined = undefined;
	private lastQr: string | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private logger = pino({
		level: process.env.LOG_LEVEL || "debug",
		transport: { target: "pino-pretty", options: { colorize: true } },
	});

	async connect() {
		this.resetReconnectState();
		this.logger.info("[WhatsApp] Starting Baileys connection...");
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
			throw new Error("WhatsApp is not connected");
		}
		const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
		await this.sock.sendMessage(jid, { text });
		this.logger.info({ jid }, "[WhatsApp] Message sent");
	}

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
				{ attempts: this.reconnectAttempts - 1, reason },
				"[WhatsApp] Giving up on reconnect",
			);
			this.emit("status", { type: "disconnected", reason: message });
			return;
		}

		this.logger.info(
			{
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
			this.logger.warn({ err }, "[WhatsApp] Error while closing socket");
		}
	}

	private async startSocket() {
		// Always tear down first: reconnect used to stack sockets, both calling saveCreds → bad files.
		await this.destroySocket();

		const { version } = await fetchLatestBaileysVersion().catch(() => ({
			version: [2, 3000, 1015901307] as [number, number, number],
		}));

		const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

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
				this.logger.info("[WhatsApp] New QR code received");
				try {
					const dataUrl = await toDataURL(qr);
					this.lastQr = dataUrl;
					this.connected = false;
					this.phone = undefined;
					const payload: WhatsappStatus = { type: "qr", data: dataUrl };
					this.emit("status", payload);
				} catch (err) {
					this.logger.error({ err }, "[WhatsApp] Failed to generate QR image");
				}
			}

			if (connection === "open") {
				this.reconnectAttempts = 0;
				this.clearReconnectTimer();
				this.connected = true;
				this.lastQr = null;
				this.phone = this.sock?.user?.id?.split(":")[0];
				this.logger.info({ phone: this.phone }, "[WhatsApp] Connected");
				const payload: WhatsappStatus = {
					type: "connected",
					phone: this.phone,
				};
				this.emit("status", payload);
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
					{ reason, statusCode },
					"[WhatsApp] Connection closed",
				);

				const isAuthFailure =
					statusCode === DisconnectReason.loggedOut ||
					statusCode === 405 ||
					statusCode === DisconnectReason.connectionReplaced;

				if (isAuthFailure) {
					this.logger.warn(
						"[WhatsApp] Auth failed/logged out. Clearing whatsapp-auth directory.",
					);
					try {
						fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
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
						"[WhatsApp] Cleaned auth state - manual connect/reload required",
					);
				}
			}
		});

		this.sock.ev.on("messages.upsert", ({ messages, type }) => {
			console.log(
				"-------------------- messages, type, rest --------------------",
			);
			console.log(JSON.stringify(messages, null, 2), type);
			if (type !== "notify") return;
			for (const msg of messages) {
				if (msg.key.fromMe) continue;
				const from = msg.key.remoteJidAlt;
				const text =
					msg.message?.conversation ??
					msg.message?.extendedTextMessage?.text ??
					"[media / unsupported]";
				this.logger.info({ from, text }, "[WhatsApp] Incoming message");
			}
		});
	}
}
