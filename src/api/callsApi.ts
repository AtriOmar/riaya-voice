import { nextjsApi } from "./nextjsApiClient.js";

/** Client for the Next.js /api/calls endpoints (internal secret set on `nextjsApi`). */

/** In-memory cache of ongoing `POST /api/calls` requests, keyed by callSid,
 *  so both `/incoming-call` and the media-stream `start` event resolve to the
 *  same DB row id without racing. */
const pendingCallCreations = new Map<string, Promise<number | null>>();

export type CreateCallInput = {
	callSid: string;
	from?: string;
	to?: string;
	direction?: string;
};

export function ensureCallRow(input: CreateCallInput): Promise<number | null> {
	const existing = pendingCallCreations.get(input.callSid);
	console.log("-------------------- existing --------------------");
	console.log(existing);
	if (existing) return existing;
	console.log("-------------------- no existing --------------------");

	const promise = (async (): Promise<number | null> => {
		try {
			const { data } = await nextjsApi.post<{ id: number }>(
				"/api/calls",
				input,
			);
			return data.id;
		} catch (err) {
			console.error("[callsApi] ensureCallRow failed", err);
			return null;
		}
	})();

	pendingCallCreations.set(input.callSid, promise);
	// Keep the cache bounded — clear entry after 5 minutes to avoid memory leak.
	setTimeout(() => pendingCallCreations.delete(input.callSid), 5 * 60 * 1000);
	return promise;
}

export type CreateCallEventInput = {
	type:
		| "patient_transcript"
		| "ai_transcript"
		| "function_call"
		| "system"
		| "error"
		| "appointment_booked";
	content?: string;
	functionName?: string;
	functionArgs?: unknown;
	functionResult?: unknown;
	functionStatus?: "calling" | "success" | "error";
};

export async function createCallEvent(
	callId: number,
	input: CreateCallEventInput,
): Promise<void> {
	try {
		await nextjsApi.post(`/api/calls/${callId}/events`, input);
	} catch (err) {
		console.error("[callsApi] createCallEvent failed", err);
	}
}

export type UpdateCallInput = {
	status?: "in-progress" | "completed" | "failed";
	callerName?: string;
	endedAt?: string;
	duration?: number;
	appointmentId?: number | null;
};

export async function updateCall(
	callId: number,
	input: UpdateCallInput,
): Promise<void> {
	try {
		await nextjsApi.put(`/api/calls/${callId}`, input);
	} catch (err) {
		console.error("[callsApi] updateCall failed", err);
	}
}
