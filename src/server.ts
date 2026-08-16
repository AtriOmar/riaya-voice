import http from "node:http";
import { config } from "dotenv";

config();

import cors from "cors";
import express, {
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { pino } from "pino";
import { type WebSocket, WebSocketServer } from "ws";
import { ensureCallRow } from "./api/callsApi.js";
import { ensurePersonRow } from "./api/personsApi.js";
import { whatsappManager } from "./services/whatsappManager.js";
import type { WhatsappStatus } from "./services/whatsappService.js";
import { getSystemMessage } from "./sessions/systemMessages.js";
import { TwilioSession } from "./sessions/twilioSession.js";

const PORT = process.env.PORT || 8080;

const logger = pino({
	level: process.env.LOG_LEVEL || "debug",
	transport: { target: "pino-pretty", options: { colorize: true } },
});

const app = express();
const server = http.createServer(app);

/** Escape for use inside TwiML double-quoted attribute values */
function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Three WebSocket servers: Twilio media streams, dashboard monitoring, WhatsApp admin
const twilioWss = new WebSocketServer({ noServer: true });
const dashboardWss = new WebSocketServer({ noServer: true });
const whatsappWss = new WebSocketServer({ noServer: true });

// Store for dashboard monitoring connections
const dashboardClients = new Set<WebSocket>();

// Store for WhatsApp UI connections, keyed by userId
const whatsappClients = new Map<string, Set<WebSocket>>();

// ==================== HTTP Routes ====================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (_req: Request, res: Response) => {
	res.json({ status: "ok", service: "riaya-realtime" });
});

// WhatsApp connection status — polled by the config page on load
// Query param: ?userId=<userId>  (defaults to "admin" for backward compat)
app.get("/whatsapp-status", (req: Request, res: Response) => {
	const userId = (req.query.userId as string | undefined)?.trim() || "admin";
	res.json(whatsappManager.getService(userId).getStatus());
});

// Send a WhatsApp message — called by web-ts appointment/prescription flow
// Body: { userId: string; phone: string; message?: string; documentUrl?: string; fileName?: string }
app.post("/send-whatsapp", async (req: Request, res: Response) => {
	const { userId, phone, message, documentUrl, fileName, mimetype } = req.body as {
		userId?: string;
		phone?: string;
		message?: string;
		documentUrl?: string;
		fileName?: string;
		mimetype?: string;
	};
	if (!phone) {
		res.status(400).json({ error: "phone is required" });
		return;
	}
	if (!message && !documentUrl) {
		res.status(400).json({ error: "message or documentUrl is required" });
		return;
	}
	const resolvedUserId = userId?.trim() || "admin";
	try {
		const service = whatsappManager.getService(resolvedUserId);
		if (documentUrl) {
			await service.sendDocument(phone, documentUrl, fileName, message, mimetype);
		} else {
			await service.sendMessage(phone, message!);
		}
		res.json({ ok: true });
	} catch (err) {
		logger.error(
			{ err, userId: resolvedUserId },
			"🔥 [WhatsApp] Failed to send message/document via HTTP route",
		);
		res.status(500).json({ error: "Failed to send message/document" });
	}
});

// Twilio webhook: returns TwiML to connect the call to a media stream
app.all("/incoming-call", (req: Request, res: Response) => {
	// Host for wss://…/media-stream must reach THIS realtime server (ngrok/tunnel), not Next.js.
	const fromEnv = process.env.PUBLIC_SOCKET_HOST?.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/$/, "");
	const host = fromEnv || req.get("host")?.trim() || "localhost:8080";

	const pickStr = (key: string): string => {
		const v =
			typeof req.body?.[key] === "string"
				? req.body[key]
				: typeof req.query?.[key] === "string"
					? (req.query[key] as string)
					: "";
		return v.trim();
	};

	const from = pickStr("From");
	const to = pickStr("To");
	const direction = pickStr("Direction");
	const callSid = pickStr("CallSid");

	const callerParameter =
		from.length > 0
			? `\n    <Parameter name="callerPhone" value="${escapeXmlAttr(from)}" />`
			: "";

	logger.info(
		{ host, hasCallerPhone: from.length > 0, callSid },
		"📞 Incoming call webhook",
	);

	// Fire-and-forget: create the call row and person in Next.js. TwilioSession
	// will await the same cached promises before persisting events / updating person.
	if (callSid) {
		ensureCallRow({ callSid, from, to, direction }).catch((err) =>
			logger.error({ err }, "🔥 Failed to create call row"),
		);
	}
	if (from) {
		ensurePersonRow(from).catch((err) =>
			logger.error({ err }, "🔥 Failed to upsert person"),
		);
	}

	const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">${callerParameter}
    </Stream>
  </Connect>
</Response>`;

	res.type("text/xml").send(twiml);
});

// ==================== WebSocket Upgrade ====================

server.on("upgrade", (request, socket, head) => {
	if (!request.url) {
		socket.destroy();
		return;
	}

	const { pathname } = new URL(request.url, `http://${request.headers.host}`);

	if (pathname === "/media-stream") {
		twilioWss.handleUpgrade(request, socket, head, (ws) => {
			twilioWss.emit("connection", ws, request);
		});
	} else if (pathname === "/dashboard") {
		dashboardWss.handleUpgrade(request, socket, head, (ws) => {
			dashboardWss.emit("connection", ws, request);
		});
	} else if (pathname === "/whatsapp") {
		whatsappWss.handleUpgrade(request, socket, head, (ws) => {
			whatsappWss.emit("connection", ws, request);
		});
	} else {
		socket.destroy();
	}
});

// ==================== Twilio Media Stream Connections ====================

twilioWss.on("connection", (ws: WebSocket) => {
	logger.info("📞 Twilio media stream connected");

	const systemMessage = getSystemMessage("doctor-appointment");
	if (!systemMessage) {
		logger.error("🔥 System message 'doctor-appointment' not found");
		ws.close();
		return;
	}

	// Each Twilio call gets its own session that bridges Twilio ↔ OpenAI ↔ Dashboard
	new TwilioSession(ws, logger, systemMessage, dashboardClients);
});

// ==================== Dashboard Monitoring Connections ====================

dashboardWss.on("connection", (ws: WebSocket) => {
	logger.info("🖥️ Dashboard client connected");
	dashboardClients.add(ws);

	ws.on("close", () => {
		dashboardClients.delete(ws);
		logger.info("🖥️ Dashboard client disconnected");
	});

	ws.on("error", (error) => {
		logger.error({ error }, "🔥 Dashboard WebSocket error");
		dashboardClients.delete(ws);
	});

	// Send a welcome message
	ws.send(
		JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }),
	);
});

// ==================== WhatsApp Config Connections ====================
// URL: ws://<host>/whatsapp?userId=<userId>  (defaults to "admin")

whatsappWss.on("connection", (ws: WebSocket, request) => {
	const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
	const userId = url.searchParams.get("userId")?.trim() || "admin";

	logger.info({ userId }, "📱 WhatsApp config client connected");

	// Track per-userId clients
	if (!whatsappClients.has(userId)) {
		whatsappClients.set(userId, new Set());
	}
	// biome-ignore lint: non-null after set above
	whatsappClients.get(userId)!.add(ws);

	const service = whatsappManager.getService(userId);
	service.addUiClient();

	// Forward status events from this service to this specific WS client
	const onStatus = (payload: WhatsappStatus) => {
		if (ws.readyState === 1 /* OPEN */) {
			ws.send(JSON.stringify(payload));
		}
	};
	service.on("status", onStatus);

	// Send the current status immediately so the page doesn't wait for the next event
	const status = service.getStatus();
	if (status.connected) {
		ws.send(JSON.stringify({ type: "connected", phone: status.phone }));
	} else {
		const lastQr = service.getLastQr();
		if (lastQr) {
			ws.send(JSON.stringify({ type: "qr", data: lastQr }));
		} else {
			ws.send(JSON.stringify({ type: "disconnected" }));
			// Automatically attempt connection/QR generation if not connected and no QR is cached
			service
				.connect()
				.catch((err) =>
					logger.error({ err, userId }, "🔥 WhatsApp reconnect on WS connect failed"),
				);
		}
	}

	ws.on("message", async (raw) => {
		try {
			const msg = JSON.parse(raw.toString()) as {
				type: string;
				phone?: string;
				message?: string;
			};
			if (msg.type === "send_message" && msg.phone && msg.message) {
				await service.sendMessage(msg.phone, msg.message);
			} else if (msg.type === "request_qr" || msg.type === "reconnect") {
				await service.connect();
			}
		} catch (err) {
			logger.error({ err, userId }, "🔥 WhatsApp config WS message error");
		}
	});

	const cleanup = () => {
		service.off("status", onStatus);
		service.removeUiClient();
		whatsappClients.get(userId)?.delete(ws);
		logger.info({ userId }, "📱 WhatsApp config client disconnected");
	};

	ws.on("close", cleanup);
	ws.on("error", (error) => {
		logger.error({ error, userId }, "🔥 WhatsApp config WebSocket error");
		cleanup();
	});
});

// ==================== Error Handling ====================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
	logger.error(err, "🔥 Unhandled error");
	res.status(500).json({ error: "Internal server error" });
});

// ==================== Start Server ====================

server.listen(PORT, () => {
	logger.info(`🟢 Riaya Realtime server started on http://localhost:${PORT}`);
	// Start admin WhatsApp after the server is up so process errors don't block startup
	whatsappManager
		.getService("admin")
		.connect()
		.catch((err) =>
			logger.error({ err }, "🔥 Admin WhatsApp service failed to start"),
		);
});

server.on("close", () => {
	logger.info("🔴 Server stopped");
});
