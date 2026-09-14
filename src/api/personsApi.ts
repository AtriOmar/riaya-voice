import { nextjsApi } from "./nextjsApiClient.js";

/** In-memory cache of ongoing `POST /api/persons` requests, keyed by phone number,
 *  so both `/incoming-call` and the media-stream `start` event resolve to the
 *  same person id without racing. */
const pendingPersonCreations = new Map<string, Promise<PersonRow | null>>();

export type PersonRow = {
	id: number;
	firstName?: string | null;
	lastName?: string | null;
	preferredLanguage?: string | null;
};

export type UpdatePersonInput = {
	firstName?: string;
	lastName?: string;
	dateOfBirth?: string;
	gender?: string;
	address?: string;
	preferredLanguage?: "en" | "fr" | "ar";
};

export function ensurePersonRow(phoneNumber: string): Promise<PersonRow | null> {
	const trimmed = phoneNumber.trim();
	if (!trimmed) return Promise.resolve(null);

	const existing = pendingPersonCreations.get(trimmed);
	if (existing) return existing;

	const promise = (async (): Promise<PersonRow | null> => {
		try {
			const { data } = await nextjsApi.post<PersonRow>("/api/persons", {
				phoneNumber: trimmed,
				source: "call",
			});
			return data;
		} catch (err) {
			console.error("[personsApi] ensurePersonRow failed", err);
			return null;
		}
	})();

	pendingPersonCreations.set(trimmed, promise);
	// Only dedupe concurrent upserts (e.g. /incoming-call + media `start`). Each new
	// call should POST again so dashboard name/language updates are picked up.
	void promise.finally(() => {
		pendingPersonCreations.delete(trimmed);
	});
	return promise;
}

export async function updatePersonRow(
	personId: number,
	input: UpdatePersonInput,
): Promise<{ id: number }> {
	const { data } = await nextjsApi.patch<{ id: number }>(
		`/api/persons/${personId}`,
		input,
	);
	return data;
}
