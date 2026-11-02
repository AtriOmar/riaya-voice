import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived tickets that let a browser open a WebSocket or call an HTTP route
 * of this server. The web app signs them after checking the user's session, with
 * the secret both services already share (INTERNAL_API_SECRET). The same format is
 * written in the web app (`src/lib/realtime-ticket.ts`).
 *
 * Scopes:
 *  - `dashboard`: live call feed. `admin` gets everything; a doctor's ticket
 *    carries `doctorId` and only receives that doctor's booking events.
 *  - `whatsapp`: link or log out the WhatsApp account of `userId`.
 *  - `test-call`: the admin test-call page (simulated call, callback inbox).
 *  - `stream`: issued here for the Twilio media stream of one call.
 */
export type TicketScope = "dashboard" | "whatsapp" | "test-call" | "stream";

export type TicketClaims = {
	scope: TicketScope;
	/** Expiry, in seconds since the epoch. */
	exp: number;
	admin?: boolean;
	doctorId?: number;
	userId?: string;
};

function secret(): string {
	return process.env.INTERNAL_API_SECRET ?? "";
}

function sign(payload: string): string {
	return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function signTicket(
	claims: Omit<TicketClaims, "exp">,
	ttlSeconds: number,
): string {
	const body = Buffer.from(
		JSON.stringify({
			...claims,
			exp: Math.floor(Date.now() / 1000) + ttlSeconds,
		}),
	).toString("base64url");
	return `${body}.${sign(body)}`;
}

/** The claims of a valid, unexpired ticket of the given scope, otherwise null. */
export function verifyTicket(
	token: string | null | undefined,
	scope: TicketScope,
): TicketClaims | null {
	if (!token || !secret()) return null;
	const [body, signature, extra] = token.split(".");
	if (!body || !signature || extra !== undefined) return null;
	const expected = sign(body);
	if (
		signature.length !== expected.length ||
		!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		return null;
	}
	try {
		const claims = JSON.parse(
			Buffer.from(body, "base64url").toString(),
		) as TicketClaims;
		if (claims.scope !== scope) return null;
		if (typeof claims.exp !== "number" || claims.exp < Date.now() / 1000) {
			return null;
		}
		return claims;
	} catch {
		return null;
	}
}
