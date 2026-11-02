import type { NextFunction, Request, Response } from "express";
import twilio from "twilio";

/** Public base URL Twilio calls: the tunnel or domain, never the container's own host. */
function publicBase(req: Request): string {
	const fromEnv = process.env.PUBLIC_SOCKET_HOST?.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/$/, "");
	const host =
		fromEnv || req.get("x-forwarded-host") || req.get("host") || "localhost";
	return `https://${host}`;
}

/**
 * Express middleware for Twilio webhooks: rejects any request that does not
 * carry a valid `X-Twilio-Signature` for the URL Twilio called. The signature
 * is computed with the account's auth token, so it must be set even when the
 * REST client uses an API key.
 */
export function requireTwilioSignature(
	req: Request,
	res: Response,
	next: NextFunction,
): void {
	const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
	const signature = req.get("x-twilio-signature");
	if (!authToken || !signature) {
		res.status(403).type("text/plain").send("Forbidden");
		return;
	}
	const url = `${publicBase(req)}${req.originalUrl}`;
	const params =
		req.method === "POST" && req.body && typeof req.body === "object"
			? (req.body as Record<string, string>)
			: {};
	if (!twilio.validateRequest(authToken, signature, url, params)) {
		res.status(403).type("text/plain").send("Forbidden");
		return;
	}
	next();
}
