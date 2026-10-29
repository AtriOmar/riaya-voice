import { timingSafeEqual } from "node:crypto";
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
import { isCallerBlocked } from "./api/abuseApi.js";
import { startCallRecording } from "./api/callRecording.js";
import { ensureCallRow } from "./api/callsApi.js";
import { ensurePersonRow } from "./api/personsApi.js";
import { signTicket, type TicketClaims, verifyTicket } from "./auth/tickets.js";
import { requireTwilioSignature } from "./auth/twilioSignature.js";
import { DashboardHub } from "./services/dashboardHub.js";
import { registerTestCallInbox } from "./services/testCallInbox.js";
import { whatsappManager } from "./services/whatsappManager.js";
import type { WhatsappStatus } from "./services/whatsappService.js";
import { getSystemMessage } from "./sessions/systemMessages.js";
import { TwilioSession } from "./sessions/twilioSession.js";
import "./workers/reviewWorker.js"; // Start the review worker
import "./workers/subscriptionWorker.js"; // Start the subscription cron worker
import { handleCallbackStatus } from "./workers/pendingTimeoutWorker.js"; // Auto-cancel unanswered AI pending appointments

const PORT = process.env.PORT || 8080;

const logger = pino({
	level: process.env.LOG_LEVEL || "debug",
	transport: { target: "pino-pretty", options: { colorize: true } },
});

const app = express();
const server = http.createServer(app);

/** Constant-time check of the `x-internal-secret` header against INTERNAL_API_SECRET. */
function hasInternalSecret(header: string | string[] | undefined): boolean {
	const expected = process.env.INTERNAL_API_SECRET ?? "";
	const given = typeof header === "string" ? header : "";
	if (!expected || given.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Express guard for server-to-server routes: the web app's shared secret. */
function requireInternalSecret(
	req: Request,
	res: Response,
	next: NextFunction,
): void {
	if (!hasInternalSecret(req.headers["x-internal-secret"])) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	next();
}

/** The WhatsApp ticket in `Authorization: Bearer <ticket>`, from the web app. */
function whatsappClaims(req: Request) {
	const header = req.get("authorization") ?? "";
	return verifyTicket(header.replace(/^Bearer\s+/i, ""), "whatsapp");
}

/** Escape for use inside TwiML double-quoted attribute values */
function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// WebSocket servers: Twilio media streams, dashboard monitoring, WhatsApp admin,
// and dashboard events relayed from the LiveKit agent process
const twilioWss = new WebSocketServer({ noServer: true });
const dashboardWss = new WebSocketServer({ noServer: true });
const whatsappWss = new WebSocketServer({ noServer: true });
const agentEventsWss = new WebSocketServer({ noServer: true });
const testCallInboxWss = new WebSocketServer({ noServer: true });

// Live feed for the admin Live Calls page and the doctors' calendars
const dashboardHub = new DashboardHub();

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
// Needs a `whatsapp` ticket; the account is the ticket's userId.
app.get("/whatsapp-status", (req: Request, res: Response) => {
	const claims = whatsappClaims(req);
	if (!claims?.userId) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	const userId = claims.userId;
	res.json(whatsappManager.getService(userId).getStatus());
});

// Log out of WhatsApp and clear auth so a different account can be linked
// Needs a `whatsapp` ticket; the account is the ticket's userId.
app.post("/whatsapp-logout", async (req: Request, res: Response) => {
	const claims = whatsappClaims(req);
	if (!claims?.userId) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	const userId = claims.userId;
	try {
		await whatsappManager.getService(userId).logout();
		res.json({ ok: true });
	} catch (err) {
		logger.error({ err, userId }, "🔥 [WhatsApp] Logout failed");
		res.status(500).json({ error: "Failed to log out of WhatsApp" });
	}
});

// Send a WhatsApp message — called by web appointment/invoice/file flows (shared secret)
// Body: { userId, phone, message?, documentUrl?, fileName?, mimetype? }
// Plan limits are enforced by the web route before it calls this.
app.post(
	"/send-whatsapp",
	requireInternalSecret,
	async (req: Request, res: Response) => {
		const { userId, phone, message, documentUrl, fileName, mimetype } =
			req.body as {
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
				await service.sendDocument(
					phone,
					documentUrl,
					fileName,
					message,
					mimetype,
				);
			} else {
				await service.sendMessage(phone, message ?? "");
			}
			res.json({ ok: true });
		} catch (err) {
			logger.error(
				{ err, userId: resolvedUserId },
				"🔥 [WhatsApp] Failed to send message/document via HTTP route",
			);
			res.status(500).json({ error: "Failed to send message/document" });
		}
	},
);

// Twilio statusCallback for outbound callbacks: WhatsApp if the patient never answered
app.post(
	"/twilio/callback-status",
	requireTwilioSignature,
	(req: Request, res: Response) => {
		const id = typeof req.query.id === "string" ? req.query.id : "";
		const status =
			typeof req.body?.CallStatus === "string" ? req.body.CallStatus : "";
		res.sendStatus(204);
		if (!id || !status) return;
		handleCallbackStatus(id, status).catch((err) =>
			logger.error({ err }, "🔥 Callback status handling failed"),
		);
	},
);

// Twilio webhook: returns TwiML to connect the call to a media stream
app.all(
	"/incoming-call",
	requireTwilioSignature,
	async (req: Request, res: Response) => {
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

		// Outbound callback placed by the pending-timeout worker: the patient is the
		// callee (`To`), and the AI opens the conversation instead of answering.
		const isCallback = req.query.mode === "callback";
		const callbackReason =
			req.query.reason === "timeout" ? "timeout" : "refused";
		const patientPhone = isCallback ? to : from;

		const callerParameter =
			patientPhone.length > 0
				? `\n    <Parameter name="callerPhone" value="${escapeXmlAttr(patientPhone)}" />`
				: "";
		const callbackParameters = isCallback
			? `\n    <Parameter name="callMode" value="callback" />\n    <Parameter name="callbackReason" value="${callbackReason}" />`
			: "";

		logger.info(
			{ host, hasCallerPhone: patientPhone.length > 0, callSid, isCallback },
			"📞 Incoming call webhook",
		);

		// Numbers an admin blocked never reach the AI: Twilio rejects the call before
		// any media stream starts. Callbacks are ours to place, so they skip this.
		if (!isCallback && patientPhone && (await isCallerBlocked(patientPhone))) {
			logger.info({ callSid }, "🚫 Blocked number rejected");
			res.type("text/xml").send(
				`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Reject reason="busy" />
</Response>`,
			);
			return;
		}

		// Fire-and-forget: create the call row and person in Next.js. TwilioSession
		// will await the same cached promises before persisting events / updating person.
		if (callSid) {
			ensureCallRow({ callSid, from, to, direction }).catch((err) =>
				logger.error({ err }, "🔥 Failed to create call row"),
			);
		}
		if (patientPhone) {
			ensurePersonRow(patientPhone).catch((err) =>
				logger.error({ err }, "🔥 Failed to upsert person"),
			);
		}

		// CALL_ROUTER=livekit hands the call to the LiveKit agent over SIP;
		// anything else keeps the media-stream session (Gemini Live etc.).
		// Callbacks always use the media-stream session (it has the callback prompt).
		const useLivekit =
			!isCallback &&
			process.env.CALL_ROUTER?.trim().toLowerCase() === "livekit";
		// Only the stream opened by this TwiML may start a session.
		const streamToken = signTicket({ scope: "stream" }, 300);
		const twiml = useLivekit
			? livekitDialTwiml({ to, callSid })
			: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream?t=${streamToken}">${callerParameter}${callbackParameters}
    </Stream>
  </Connect>
</Response>`;
		logger.info(
			{ router: useLivekit ? "livekit" : "media-stream" },
			"📞 Call router",
		);

		res.type("text/xml").send(twiml);

		// Record after answering with the TwiML (the call is live by now). Blocked
		// callers returned above and are never recorded.
		if (callSid) {
			startCallRecording(callSid, logger).catch((err) =>
				logger.error({ err }, "🔥 Failed to start call recording"),
			);
		}
	},
);

/**
 * TwiML that bridges the call to LiveKit SIP. The CallSid travels as a custom
 * SIP header so the agent can reuse the call row created above (the LiveKit
 * inbound trunk maps `X-Twilio-CallSid` to the `twilio.callSid` attribute).
 */
function livekitDialTwiml({ to, callSid }: { to: string; callSid: string }) {
	const sipHost = process.env.LIVEKIT_SIP_HOST?.trim() ?? "";
	const username = process.env.LIVEKIT_SIP_USERNAME?.trim() ?? "";
	const password = process.env.LIVEKIT_SIP_PASSWORD?.trim() ?? "";
	const header = callSid
		? `?X-Twilio-CallSid=${encodeURIComponent(callSid)}`
		: "";
	const uri = `sip:${to}@${sipHost};transport=tcp${header}`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip username="${escapeXmlAttr(username)}" password="${escapeXmlAttr(password)}">${escapeXmlAttr(uri)}</Sip>
  </Dial>
</Response>`;
}

// ==================== WebSocket Upgrade ====================

/** Claims of the ticket a WebSocket connected with, read by the connection handlers. */
const socketClaims = new WeakMap<http.IncomingMessage, TicketClaims>();

function reject(socket: import("node:stream").Duplex, status: string) {
	socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
	socket.destroy();
}

server.on("upgrade", (request, socket, head) => {
	if (!request.url) {
		socket.destroy();
		return;
	}

	const url = new URL(request.url, `http://${request.headers.host}`);
	const { pathname } = url;
	const ticket = url.searchParams.get("ticket");

	const accept = (wss: WebSocketServer) =>
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, request);
		});

	if (pathname === "/media-stream") {
		// Twilio's stream carries the token from our TwiML; the admin test-call
		// page carries a ticket.
		const fromTwilio = verifyTicket(url.searchParams.get("t"), "stream");
		const fromTestPage = verifyTicket(ticket, "test-call");
		if (!fromTwilio && !fromTestPage?.admin) {
			reject(socket, "401 Unauthorized");
			return;
		}
		accept(twilioWss);
	} else if (pathname === "/dashboard") {
		const claims = verifyTicket(ticket, "dashboard");
		if (!claims || !(claims.admin || claims.doctorId)) {
			reject(socket, "401 Unauthorized");
			return;
		}
		socketClaims.set(request, claims);
		accept(dashboardWss);
	} else if (pathname === "/whatsapp") {
		const claims = verifyTicket(ticket, "whatsapp");
		if (!claims?.userId) {
			reject(socket, "401 Unauthorized");
			return;
		}
		socketClaims.set(request, claims);
		accept(whatsappWss);
	} else if (pathname === "/test-call-inbox") {
		const claims = verifyTicket(ticket, "test-call");
		if (!claims?.admin) {
			reject(socket, "401 Unauthorized");
			return;
		}
		accept(testCallInboxWss);
	} else if (pathname === "/agent-events") {
		if (!hasInternalSecret(request.headers["x-internal-secret"])) {
			reject(socket, "401 Unauthorized");
			return;
		}
		accept(agentEventsWss);
	} else {
		socket.destroy();
	}
});

// ==================== Twilio Media Stream Connections ====================

twilioWss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
	logger.info("📞 Twilio media stream connected");

	const systemMessage = getSystemMessage("doctor-appointment");
	if (!systemMessage) {
		logger.error("🔥 System message 'doctor-appointment' not found");
		ws.close();
		return;
	}

	// Each Twilio call gets its own session that bridges Twilio ↔ OpenAI ↔ Dashboard
	// Test-call page only: `?cs=<callSid>` points at per-call model settings in Redis.
	const settingsSid = new URL(
		request.url ?? "/",
		"http://localhost",
	).searchParams.get("cs");
	new TwilioSession(ws, logger, systemMessage, dashboardHub, settingsSid);
});

// ==================== Test-call Inbox ====================
// URL: ws://<host>/test-call-inbox?phone=<phone>
// The /test-call page listens here so callbacks ring the page, not Twilio.

testCallInboxWss.on("connection", (ws: WebSocket, request) => {
	const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
	const phone = url.searchParams.get("phone")?.trim() ?? "";
	if (!phone) {
		ws.close();
		return;
	}
	const unregister = registerTestCallInbox(phone, ws);
	logger.info({ phone }, "☎️ Test-call inbox connected");
	ws.on("close", unregister);
	ws.on("error", (error) => {
		logger.error({ error }, "🔥 Test-call inbox WebSocket error");
		unregister();
	});
});

// ==================== LiveKit Agent Event Relay ====================
// The LiveKit agent runs in its own process; it sends DashboardMessage JSON here
// and we fan it out to dashboard clients exactly like TwilioSession does.

agentEventsWss.on("connection", (ws: WebSocket) => {
	logger.info("🤖 LiveKit agent relay connected");
	ws.on("message", (data) => {
		dashboardHub.publish(data.toString());
	});
	ws.on("error", (error) =>
		logger.error({ error }, "🔥 Agent relay WebSocket error"),
	);
});

// ==================== Dashboard Monitoring Connections ====================

dashboardWss.on("connection", (ws: WebSocket, request) => {
	const claims = socketClaims.get(request);
	const remove = claims?.admin
		? dashboardHub.addAdmin(ws)
		: dashboardHub.addDoctor(claims?.doctorId ?? 0, ws);
	logger.info("🖥️ Dashboard client connected");

	ws.on("close", () => {
		remove();
		logger.info("🖥️ Dashboard client disconnected");
	});

	ws.on("error", (error) => {
		logger.error({ error }, "🔥 Dashboard WebSocket error");
		remove();
	});

	// Send a welcome message
	ws.send(
		JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }),
	);
});

// ==================== WhatsApp Config Connections ====================
// URL: ws://<host>/whatsapp?ticket=<whatsapp ticket>

whatsappWss.on("connection", (ws: WebSocket, request) => {
	// The account is the one the ticket was issued for, never a query parameter.
	const userId = socketClaims.get(request)?.userId ?? "";
	if (!userId) {
		ws.close();
		return;
	}

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
					logger.error(
						{ err, userId },
						"🔥 WhatsApp reconnect on WS connect failed",
					),
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
			} else if (msg.type === "logout") {
				await service.logout();
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
