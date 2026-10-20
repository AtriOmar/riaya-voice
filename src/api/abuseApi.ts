import { nextjsApi } from "./nextjsApiClient.js";

/** Must answer before Twilio's webhook timeout; a slow check lets the call in. */
const BLOCK_CHECK_TIMEOUT_MS = 1500;

export const callReportCategories = [
	"mocking",
	"insults",
	"threats",
	"sexual",
	"other",
] as const;
export type CallReportCategory = (typeof callReportCategories)[number];

/**
 * True when an admin blocked this number. Fails open: if Next is slow or down,
 * the call goes through so real patients are never turned away by an outage.
 */
export async function isCallerBlocked(phoneNumber: string): Promise<boolean> {
	const trimmed = phoneNumber.trim();
	if (!trimmed) return false;
	try {
		const { data } = await nextjsApi.post<{ blocked: boolean }>(
			"/api/internal/caller/blocked",
			{ phoneNumber: trimmed },
			{ timeout: BLOCK_CHECK_TIMEOUT_MS },
		);
		return data.blocked === true;
	} catch (err) {
		console.error(
			"[abuseApi] isCallerBlocked failed, letting the call in",
			err,
		);
		return false;
	}
}

export async function reportAbusiveCall(input: {
	callSid: string;
	phoneNumber: string;
	category: CallReportCategory;
	summary: string;
}): Promise<{ id: number }> {
	const { data } = await nextjsApi.post<{ id: number }>(
		"/api/internal/calls/report",
		input,
	);
	return data;
}
