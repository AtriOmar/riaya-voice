import twilio from "twilio";

export type TwilioClient = ReturnType<typeof twilio>;

let cached: TwilioClient | null = null;

/**
 * Twilio REST client from env. Supports either:
 *  - TWILIO_ACCOUNT_SID (AC…) + TWILIO_AUTH_TOKEN, or
 *  - TWILIO_ACCOUNT_SID (AC…) + TWILIO_API_KEY_SID (SK…) + TWILIO_API_KEY_SECRET.
 * Returns null (and logs why) when the config is missing or inconsistent.
 */
export function getTwilioClient(): TwilioClient | null {
	if (cached) return cached;

	const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
	const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
	const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim();
	const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim();

	if (!accountSid) {
		console.error("[twilio] TWILIO_ACCOUNT_SID is not set");
		return null;
	}
	if (!accountSid.startsWith("AC")) {
		console.error(
			`[twilio] TWILIO_ACCOUNT_SID must start with "AC" (got "${accountSid.slice(0, 2)}…"). ` +
				"For an API key, put the AC… account SID here and the key in TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET.",
		);
		return null;
	}

	if (apiKeySid && apiKeySecret) {
		cached = twilio(apiKeySid, apiKeySecret, { accountSid });
		return cached;
	}
	if (authToken) {
		cached = twilio(accountSid, authToken);
		return cached;
	}
	console.error(
		"[twilio] Set TWILIO_AUTH_TOKEN, or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET",
	);
	return null;
}
