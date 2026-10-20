import { nextjsApi } from "./nextjsApiClient.js";

/** A place the patient searched from: a name (when known) and its coordinates. */
export type CallerPlace = {
	label: string | null;
	latitude: number;
	longitude: number;
};

/**
 * The place this phone line searched from on its last phone booking, so the
 * assistant can offer the same area. Never throws: a failure just means the
 * assistant asks for the place as usual.
 */
export async function getCallerLastPlace(
	callerPhone: string,
): Promise<CallerPlace | null> {
	try {
		const { data } = await nextjsApi.post<{
			found: boolean;
			label: string | null;
			latitude: number | null;
			longitude: number | null;
		}>(
			"/api/internal/caller/last-place",
			{ phoneNumber: callerPhone.trim() },
			{ timeout: 3000 },
		);
		if (!data.found || data.latitude === null || data.longitude === null)
			return null;
		return {
			label: data.label,
			latitude: data.latitude,
			longitude: data.longitude,
		};
	} catch (err) {
		console.error("[callerPlaceApi] getCallerLastPlace failed", err);
		return null;
	}
}
