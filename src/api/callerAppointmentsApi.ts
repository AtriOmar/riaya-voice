import { nextjsApi } from "./nextjsApiClient.js";

const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

const internalHeaders = () => ({
	"x-internal-secret": INTERNAL_API_SECRET,
	"Content-Type": "application/json",
});

export type CallerAiAppointmentItem = {
	appointmentId: number;
	status: string | null;
	start: string | null;
	end: string | null;
	name: string | null;
	description: string | null;
	doctorName: string;
	cabinetName: string | null;
	address: string | null;
	urgent?: boolean;
};

export type ListCallerAiAppointmentsResult = {
	upcoming: CallerAiAppointmentItem[];
	recentPast: CallerAiAppointmentItem[];
};

export async function listCallerAiAppointments(
	callerPhone: string,
	options?: { includeRecentPast?: boolean },
): Promise<ListCallerAiAppointmentsResult> {
	const { data } = await nextjsApi.post<ListCallerAiAppointmentsResult>(
		"/api/internal/caller/ai-appointments/list",
		{
			phoneNumber: callerPhone.trim(),
			includeRecentPast: options?.includeRecentPast,
		},
		{ headers: internalHeaders() },
	);
	return data;
}

export async function cancelCallerAiAppointment(
	callerPhone: string,
	appointmentId: number,
): Promise<{ success: true; appointmentId: number; status: string | null }> {
	const { data } = await nextjsApi.post<{
		success: true;
		appointmentId: number;
		status: string | null;
	}>(
		"/api/internal/caller/ai-appointments/cancel",
		{
			phoneNumber: callerPhone.trim(),
			appointmentId,
		},
		{ headers: internalHeaders() },
	);
	return data;
}

export type RefusalSuggestion = {
	doctorId: number;
	name: string;
	cabinetName: string | null;
	address: string | null;
	distanceKm: number;
	slotStart: string;
	slotEnd: string;
};

export type CallerRefusalContext = {
	refusedDoctorName: string | null;
	suggestions: RefusalSuggestion[];
};

/**
 * Other doctors to offer when a doctor recently refused this caller's request.
 * Never throws: a failure just means the call runs without the extra context.
 */
export async function getCallerRefusalContext(
	callerPhone: string,
): Promise<CallerRefusalContext | null> {
	try {
		const { data } = await nextjsApi.post<{
			found: boolean;
			refusedDoctorName: string | null;
			suggestions: RefusalSuggestion[];
		}>(
			"/api/internal/caller/refusal-context",
			{ phoneNumber: callerPhone.trim() },
			{ headers: internalHeaders(), timeout: 3000 },
		);
		if (!data.found || data.suggestions.length === 0) return null;
		return {
			refusedDoctorName: data.refusedDoctorName,
			suggestions: data.suggestions,
		};
	} catch (err) {
		console.error(
			"[callerAppointmentsApi] getCallerRefusalContext failed",
			err,
		);
		return null;
	}
}
