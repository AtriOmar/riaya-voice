import { nextjsApi } from "./nextjsApiClient.js";

export type PersonRelationship =
	| "self"
	| "child"
	| "parent"
	| "spouse"
	| "sibling"
	| "other";

/** Someone reachable on the calling phone: the owner (`self`) or a family member. */
export type PersonOnLine = {
	personId: number;
	firstName: string | null;
	lastName: string | null;
	relationship: PersonRelationship;
};

/**
 * Everyone on the caller's phone, so the assistant can ask who an appointment
 * is for. Never throws: a failure just means the call runs without the list.
 */
export async function getPeopleOnLine(
	callerPhone: string,
): Promise<PersonOnLine[]> {
	try {
		const { data } = await nextjsApi.post<{ people: PersonOnLine[] }>(
			"/api/internal/caller/people",
			{ phoneNumber: callerPhone.trim() },
			{ timeout: 3000 },
		);
		return data.people;
	} catch (err) {
		console.error("[callerPeopleApi] getPeopleOnLine failed", err);
		return [];
	}
}

/** The owner alone, from their person row: used when the full list could not be loaded. */
export function ownerOnly(row: {
	id: number;
	firstName?: string | null;
	lastName?: string | null;
}): PersonOnLine[] {
	return [
		{
			personId: row.id,
			firstName: row.firstName ?? null,
			lastName: row.lastName ?? null,
			relationship: "self",
		},
	];
}
