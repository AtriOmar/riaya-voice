import axios from "axios";
import type { Logger } from "pino";
import {
	cancelCallerAiAppointment,
	listCallerAiAppointments,
} from "../api/callerAppointmentsApi.js";
import type { createCallEvent, updateCall } from "../api/callsApi.js";
import { nextjsApi } from "../api/nextjsApiClient.js";
import { ensurePersonRow, updatePersonRow } from "../api/personsApi.js";
import { CITIES } from "../constants/cities.js";
import { SPECIALITIES } from "../constants/specialities.js";
import type { CallLanguage } from "../sessions/callInstructions.js";
import type {
	BestFitDoctor,
	BookAppointmentParams,
	DashboardMessage,
	DoctorAvailabilityResponse,
} from "../types/index.js";

/**
 * Booking tools shared by every call path (Twilio media stream session and the
 * LiveKit agent). The call path owns the per-call state and exposes it through
 * `CallToolsContext`. `end_call` stays with the call path since hanging up is
 * transport-specific.
 */

export type PersonRow = {
	id: number;
	firstName?: string | null;
	lastName?: string | null;
	preferredLanguage?: string | null;
};

export interface CallToolsContext {
	readonly logger: Logger;
	readonly callSid: string | null;
	readonly callerPhone: string | null;
	readonly personId: number | null;
	applyPersonRow(row: PersonRow): void;
	onProfileChange(change: {
		firstName?: string;
		preferredLanguage?: CallLanguage;
	}): void;
	emit(message: DashboardMessage): void;
	persistEvent(event: Parameters<typeof createCallEvent>[1]): void;
	persistCallUpdate(update: Parameters<typeof updateCall>[1]): void;
}

const CITY_SEARCH_RADIUS_M = 30_000;

function normalizeCityName(raw: string): string {
	return raw
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
}

function findCityByName(raw: string) {
	const needle = normalizeCityName(raw);
	if (!needle) return undefined;
	return CITIES.find((c) =>
		[c.slug, c.en_name, c.fr_name, c.ar_name].some(
			(n) => normalizeCityName(n) === needle,
		),
	);
}

// ==================== Tool / HTTP logging ====================

const MAX_LOG_CHARS = 8000;

export function truncateForLog(value: string, max = MAX_LOG_CHARS): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…[truncated, ${value.length} chars total]`;
}

function tryParseJsonString(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function bodyFromAxiosConfig(data: unknown): unknown {
	if (data == null) return data;
	if (typeof data === "string") return tryParseJsonString(data) ?? data;
	return data;
}

export function consoleLogToolHttpError(
	tool: string,
	ctx: { callSid?: string | null; call_id?: string; input?: unknown },
	error: unknown,
): void {
	console.log("---------------------- TOOL HTTP ERROR ----------------------");
	console.log("tool:", tool);
	console.log("callSid:", ctx.callSid);
	console.log("call_id:", ctx.call_id);
	console.log("input:", JSON.stringify(ctx.input, null, 2));
	if (axios.isAxiosError(error)) {
		console.log("axiosMessage:", error.message);
		console.log("axiosCode:", error.code);
		console.log(
			"httpStatus:",
			error.response?.status,
			error.response?.statusText,
		);
		console.log("responseData:", error.response?.data);
		console.log("requestUrl:", error.config?.url);
		console.log("requestMethod:", error.config?.method);
		console.log("requestParams:", error.config?.params);
		console.log("requestBody:", bodyFromAxiosConfig(error.config?.data));
	} else {
		console.log("non-axios error:", error);
	}
	console.log("-------------------------------------------------------------");
}

export function toolFailureMessage(tool: string, error: unknown): string {
	if (axios.isAxiosError(error)) {
		const status = error.response?.status;
		const data = error.response?.data;
		const detail =
			data === undefined || data === null
				? ""
				: typeof data === "string"
					? truncateForLog(data, 2500)
					: truncateForLog(JSON.stringify(data), 2500);
		const suffix = detail ? ` — ${detail}` : "";
		return `${tool}: HTTP ${String(status ?? "?")} ${error.message}${suffix}`;
	}
	if (error instanceof Error) return `${tool}: ${error.message}`;
	return `${tool}: ${String(error)}`;
}

type FindAvailableSlotsArgs = {
	specialitySlug: string;
	latitude: number;
	longitude: number;
	preferredTime?: string;
};

type FindDoctorSlotsArgs = {
	doctorId: number;
	preferredTime?: string;
	limit?: number;
};

type BookAppointmentToolArgs = {
	doctorId: number | string;
	patientName: string;
	illness: string;
	start: string;
	end: string;
};

type BookEmergencyAppointmentsToolArgs = {
	specialitySlug: string;
	latitude: number;
	longitude: number;
	patientName: string;
	illness: string;
};

function phoneDigitsOnly(raw: string): string {
	return raw.replace(/\D/g, "");
}

type UpdatePersonInfoToolArgs = {
	firstName?: string;
	lastName?: string;
	dateOfBirth?: string;
	gender?: string;
	address?: string;
	preferredLanguage?: CallLanguage;
};

function strField(
	raw: Record<string, unknown>,
	snake: string,
	camel: string,
): string | undefined {
	const a = raw[snake];
	const b = raw[camel];
	if (typeof a === "string" && a.length > 0) return a;
	if (typeof b === "string" && b.length > 0) return b;
	return undefined;
}

function numField(
	raw: Record<string, unknown>,
	snake: string,
	camel: string,
): number | undefined {
	const a = raw[snake];
	const b = raw[camel];
	for (const v of [a, b]) {
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return undefined;
}

/** Accepts snake_case (tool schema) or legacy camelCase; maps to internal shape for HTTP. */
function normalizeFindAvailableSlotsArgs(
	raw: unknown,
): FindAvailableSlotsArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const specialitySlug = strField(o, "speciality_slug", "specialitySlug") ?? "";
	const latitude = numField(o, "latitude", "latitude");
	const longitude = numField(o, "longitude", "longitude");
	const preferredTime = strField(o, "preferred_time", "preferredTime");
	if (latitude === undefined || longitude === undefined) return null;
	return {
		specialitySlug,
		latitude,
		longitude,
		...(preferredTime !== undefined ? { preferredTime } : {}),
	};
}

/** Accepts snake_case (tool schema) or legacy camelCase; maps to internal shape for HTTP. */
function normalizeFindDoctorSlotsArgs(
	raw: unknown,
): FindDoctorSlotsArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const doctorIdRaw = o.doctor_id ?? o.doctorId;
	const preferredTime = strField(o, "preferred_time", "preferredTime");
	const limitRaw = o.limit;

	let doctorId: number | null = null;
	if (typeof doctorIdRaw === "number") doctorId = doctorIdRaw;
	if (typeof doctorIdRaw === "string" && doctorIdRaw.trim() !== "") {
		const parsed = Number(doctorIdRaw);
		if (Number.isFinite(parsed)) doctorId = parsed;
	}
	if (
		doctorId === null ||
		!Number.isInteger(doctorId) ||
		!Number.isFinite(doctorId) ||
		doctorId <= 0
	) {
		return null;
	}

	let limit: number | undefined;
	if (typeof limitRaw === "number" && Number.isFinite(limitRaw)) {
		limit = Math.max(1, Math.min(10, Math.floor(limitRaw)));
	}
	if (typeof limitRaw === "string" && limitRaw.trim() !== "") {
		const parsed = Number(limitRaw);
		if (Number.isFinite(parsed)) {
			limit = Math.max(1, Math.min(10, Math.floor(parsed)));
		}
	}

	return {
		doctorId,
		...(preferredTime !== undefined ? { preferredTime } : {}),
		...(limit !== undefined ? { limit } : {}),
	};
}

/** Accepts snake_case (tool schema) or legacy camelCase; maps to internal shape for HTTP. */
function normalizeBookAppointmentArgs(
	raw: unknown,
): BookAppointmentToolArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const doctorId = o.doctor_id ?? o.doctorId;
	const patientName = strField(o, "patient_name", "patientName");
	const illness = strField(o, "illness", "illness");
	const start = strField(o, "start", "start");
	const end = strField(o, "end", "end");
	if (
		patientName === undefined ||
		illness === undefined ||
		start === undefined ||
		end === undefined
	) {
		return null;
	}
	return {
		doctorId: doctorId as number | string,
		patientName,
		illness,
		start,
		end,
	};
}

function normalizeBookEmergencyAppointmentsArgs(
	raw: unknown,
): BookEmergencyAppointmentsToolArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const specialitySlug = strField(o, "speciality_slug", "specialitySlug");
	const latitude = numField(o, "latitude", "latitude");
	const longitude = numField(o, "longitude", "longitude");
	const patientName = strField(o, "patient_name", "patientName");
	const illness = strField(o, "illness", "illness");
	if (
		specialitySlug === undefined ||
		latitude === undefined ||
		longitude === undefined ||
		patientName === undefined ||
		illness === undefined
	) {
		return null;
	}
	return { specialitySlug, latitude, longitude, patientName, illness };
}

/** Accepts snake_case (tool schema) or legacy camelCase; maps to internal shape for HTTP. */
function normalizeUpdatePersonInfoArgs(
	raw: unknown,
): UpdatePersonInfoToolArgs | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const firstName = strField(o, "first_name", "firstName");
	const lastName = strField(o, "last_name", "lastName");
	const dateOfBirth = strField(o, "date_of_birth", "dateOfBirth");
	const gender = strField(o, "gender", "gender");
	const address = strField(o, "address", "address");
	const preferredLanguageRaw = strField(
		o,
		"preferred_language",
		"preferredLanguage",
	);
	const preferredLanguage =
		preferredLanguageRaw === "en" ||
		preferredLanguageRaw === "fr" ||
		preferredLanguageRaw === "ar"
			? preferredLanguageRaw
			: undefined;

	if (
		firstName === undefined &&
		lastName === undefined &&
		dateOfBirth === undefined &&
		gender === undefined &&
		address === undefined &&
		preferredLanguage === undefined
	) {
		return null;
	}

	return {
		...(firstName !== undefined ? { firstName } : {}),
		...(lastName !== undefined ? { lastName } : {}),
		...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
		...(gender !== undefined ? { gender } : {}),
		...(address !== undefined ? { address } : {}),
		...(preferredLanguage !== undefined ? { preferredLanguage } : {}),
	};
}

function normalizeCancelAppointmentArgs(
	raw: unknown,
): { appointmentId: number } | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const o = raw as Record<string, unknown>;
	const idRaw = o.appointment_id ?? o.appointmentId;
	let appointmentId: number | null = null;
	if (typeof idRaw === "number") appointmentId = idRaw;
	if (typeof idRaw === "string" && idRaw.trim() !== "") {
		const parsed = Number(idRaw);
		if (Number.isFinite(parsed)) appointmentId = parsed;
	}
	if (
		appointmentId === null ||
		!Number.isInteger(appointmentId) ||
		appointmentId <= 0
	) {
		return null;
	}
	return { appointmentId };
}

// ==================== CallTools ====================

export class CallTools {
	constructor(private readonly ctx: CallToolsContext) {}

	/** Runs one tool (everything except `end_call`) and returns the JSON string fed back to the model. */
	async run(
		name: string,
		parsedArgs: unknown,
		call_id?: string,
	): Promise<string> {
		let result: string;
		switch (name) {
			case "get_specialities":
				result = this.getSpecialities();
				break;
			case "get_cities":
				result = this.getCities();
				break;
			case "search_location": {
				const args = parsedArgs as { city?: string; query?: string };
				if (!args.city || !args.query) {
					result = JSON.stringify({
						error: true,
						message:
							"search_location: invalid arguments (expected city and query)",
					});
					break;
				}
				result = await this.searchLocation(args.city, args.query);
				break;
			}
			case "find_available_slots": {
				const slotArgs = normalizeFindAvailableSlotsArgs(parsedArgs);
				if (!slotArgs) {
					result = JSON.stringify({
						error: true,
						message:
							"find_available_slots: invalid arguments (expected speciality_slug, latitude, longitude, optional preferred_time)",
					});
					break;
				}
				result = await this.findAvailableSlots(slotArgs);
				break;
			}
			case "find_doctor_by_name": {
				const nameArgs = parsedArgs as { name?: unknown };
				const doctorName =
					typeof nameArgs?.name === "string" ? nameArgs.name.trim() : "";
				if (doctorName.length < 2) {
					result = JSON.stringify({
						error: true,
						message: "find_doctor_by_name: invalid arguments (expected name)",
					});
					break;
				}
				result = await this.findDoctorByName(doctorName);
				break;
			}
			case "find_doctor_slots": {
				const doctorSlotArgs = normalizeFindDoctorSlotsArgs(parsedArgs);
				if (!doctorSlotArgs) {
					result = JSON.stringify({
						error: true,
						message:
							"find_doctor_slots: invalid arguments (expected doctor_id, optional preferred_time, optional limit)",
					});
					break;
				}
				result = await this.findDoctorSlots(doctorSlotArgs);
				break;
			}
			case "book_appointment": {
				const bookArgs = normalizeBookAppointmentArgs(parsedArgs);
				if (!bookArgs) {
					result = JSON.stringify({
						error: true,
						message:
							"book_appointment: invalid arguments (expected doctor_id, patient_name, illness, start, end)",
					});
					break;
				}
				result = await this.bookAppointment(bookArgs);
				break;
			}
			case "book_emergency_appointments": {
				const emergencyArgs =
					normalizeBookEmergencyAppointmentsArgs(parsedArgs);
				if (!emergencyArgs) {
					result = JSON.stringify({
						error: true,
						message:
							"book_emergency_appointments: invalid arguments (expected speciality_slug, latitude, longitude, patient_name, illness)",
					});
					break;
				}
				result = await this.bookEmergencyAppointments(emergencyArgs);
				break;
			}
			case "update_person_info": {
				const personArgs = normalizeUpdatePersonInfoArgs(parsedArgs);
				if (!personArgs) {
					result = JSON.stringify({
						error: true,
						message:
							"update_person_info: invalid arguments (expected at least one of first_name, last_name, date_of_birth, gender, address, preferred_language)",
					});
					break;
				}
				result = await this.updatePersonInfo(personArgs);
				break;
			}
			case "list_my_ai_appointments": {
				const includeRecentPast =
					parsedArgs !== null &&
					typeof parsedArgs === "object" &&
					!Array.isArray(parsedArgs) &&
					(parsedArgs as { include_recent_past?: boolean })
						.include_recent_past === true;
				result = await this.listMyAiAppointments({ includeRecentPast });
				break;
			}
			case "cancel_appointment": {
				const cancelArgs = normalizeCancelAppointmentArgs(parsedArgs);
				if (!cancelArgs) {
					result = JSON.stringify({
						error: true,
						message:
							"cancel_appointment: invalid arguments (expected appointment_id)",
					});
					break;
				}
				result = await this.cancelAppointment(cancelArgs.appointmentId);
				break;
			}
			default:
				console.log(
					"---------------------- UNKNOWN TOOL ----------------------",
				);
				console.log("tool:", name, "call_id:", call_id, "input:", parsedArgs);
				console.log(
					"-------------------------------------------------------------",
				);
				result = JSON.stringify({ error: `Unknown function: ${name}` });
		}
		return result;
	}

	private getSpecialities(): string {
		return JSON.stringify(
			SPECIALITIES.map(({ slug, en_name, fr_name, ar_name }) => ({
				slug,
				en_name,
				fr_name,
				ar_name,
			})),
		);
	}

	private getCities(): string {
		return JSON.stringify(
			CITIES.map(
				({ slug, latitude, longitude, en_name, fr_name, ar_name }) => ({
					slug,
					latitude,
					longitude,
					en_name,
					fr_name,
					ar_name,
				}),
			),
		);
	}

	private async searchLocation(city: string, query: string): Promise<string> {
		const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;
		if (!GEOAPIFY_API_KEY) {
			this.ctx.logger.error("GEOAPIFY_API_KEY is not set");
			return JSON.stringify({
				error: true,
				message: "Geocoding API key not configured.",
			});
		}
		try {
			const cityMatch = findCityByName(city);
			const baseParams = {
				text: `${query}, ${city}`,
				limit: 5,
				apiKey: GEOAPIFY_API_KEY,
			};
			const search = async (filter: string, bias?: string) =>
				(
					await axios.get("https://api.geoapify.com/v1/geocode/search", {
						params: { ...baseParams, filter, ...(bias ? { bias } : {}) },
					})
				).data;

			let data: { features?: unknown[] };
			if (cityMatch) {
				const { longitude, latitude } = cityMatch;
				data = await search(
					`circle:${longitude},${latitude},${CITY_SEARCH_RADIUS_M}`,
					`proximity:${longitude},${latitude}`,
				);
				if (!data.features?.length) {
					this.ctx.logger.info(
						{ city: cityMatch.slug },
						"Geocoding: no results inside city radius, retrying country-wide",
					);
					data = await search(
						"countrycode:tn",
						`proximity:${longitude},${latitude}`,
					);
				}
			} else {
				data = await search("countrycode:tn");
			}
			const features = data.features || [];
			if (features.length === 0) {
				return JSON.stringify({
					found: false,
					message:
						"No results found. Please ask the patient for more context (e.g., region, city).",
				});
			}

			// biome-ignore lint/suspicious/noExplicitAny: geoapify structure
			const results = features.map((f: any) => ({
				name: f.properties.formatted,
				city: f.properties.city,
				state: f.properties.state,
				street: f.properties.street,
				latitude: f.properties.lat,
				longitude: f.properties.lon,
			}));

			return JSON.stringify({
				found: true,
				results,
				message:
					results.length > 1
						? "Multiple results found. Please ask the patient to clarify which one they mean by presenting the options."
						: "One result found. Proceed with this location.",
			});
		} catch (error) {
			this.ctx.logger.error({ error }, "Geocoding API error");
			return JSON.stringify({
				error: true,
				message: "Failed to search location.",
			});
		}
	}

	private async findAvailableSlots(params: {
		specialitySlug: string;
		latitude: number;
		longitude: number;
		preferredTime?: string;
	}): Promise<string> {
		const path = "/api/doctors/best-fit";
		// Next route expects query keys: speciality, lat, long, time
		const query = {
			speciality: params.specialitySlug,
			lat: params.latitude,
			long: params.longitude,
			time: params.preferredTime,
		};

		console.log(
			"---------------------- find_available_slots REQUEST ----------------------",
		);
		console.log("url:", nextjsApi.getUri({ url: path, params: query }));
		console.log("query:", JSON.stringify(query, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const { data } = await nextjsApi.get<BestFitDoctor[]>(path, {
			params: query,
		});

		if (!data || data.length === 0) {
			console.log(
				"---------------------- find_available_slots EMPTY ----------------------",
			);
			console.log("query:", JSON.stringify(query, null, 2));
			console.log("doctorCount:", data?.length ?? 0);
			console.log(
				"-------------------------------------------------------------",
			);
			return JSON.stringify({
				found: false,
				message:
					"No doctors with available slots were found for this speciality and location.",
			});
		}

		// Return top 3 for the AI (doctorId = doctorProfile.id for book_appointment)
		const top = data.slice(0, 3).map((doc) => ({
			doctorId: doc.id,
			name: `Dr. ${doc.firstName} ${doc.lastName}`,
			cabinet: doc.cabinetName,
			address: doc.address ?? null,
			distanceKm: Math.round(doc.distance * 10) / 10,
			slotStart: doc.nextSlot.start,
			slotEnd: doc.nextSlot.end,
			// Additional nearby slots so the AI can offer alternatives without
			// a second find_available_slots call.
			nearbySlots: (doc.nearbySlots ?? []).map((s) => ({
				slotStart: s.start,
				slotEnd: s.end,
			})),
		}));

		console.log(
			"---------------------- find_available_slots OK ----------------------",
		);
		console.log("totalMatches:", data.length, "returned:", top.length);
		console.log(
			"doctorIds:",
			top.map((d) => d.doctorId),
		);
		console.log("top:", JSON.stringify(top, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		return JSON.stringify({ found: true, doctors: top });
	}

	private async findDoctorByName(name: string): Promise<string> {
		const { data } = await nextjsApi.get<{
			doctors: {
				id: number;
				firstName: string | null;
				lastName: string | null;
				cabinetName: string | null;
				address: string | null;
				specialitySlug: string | null;
				speciality: string | null;
			}[];
		}>("/api/doctors/search", { params: { name, limit: 5 } });

		if (data.doctors.length === 0) {
			return JSON.stringify({
				found: false,
				message: "No verified doctor matches that name.",
			});
		}
		return JSON.stringify({
			found: true,
			doctors: data.doctors.map((d) => ({
				doctorId: d.id,
				name: `Dr. ${[d.firstName, d.lastName].filter(Boolean).join(" ")}`,
				speciality: d.speciality,
				specialitySlug: d.specialitySlug,
				cabinet: d.cabinetName,
				address: d.address,
			})),
		});
	}

	private async findDoctorSlots(params: {
		doctorId: number;
		preferredTime?: string;
		limit?: number;
	}): Promise<string> {
		const path = "/api/doctors/availability";
		const query = {
			doctor_id: params.doctorId,
			time: params.preferredTime,
			limit: params.limit,
		};

		console.log(
			"---------------------- find_doctor_slots REQUEST ----------------------",
		);
		console.log("url:", nextjsApi.getUri({ url: path, params: query }));
		console.log("query:", JSON.stringify(query, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const { data } = await nextjsApi.get<DoctorAvailabilityResponse>(path, {
			params: query,
		});

		const doctorName = `Dr. ${data.doctor.firstName} ${data.doctor.lastName}`;
		if (!data.found || data.slots.length === 0) {
			console.log(
				"---------------------- find_doctor_slots EMPTY ----------------------",
			);
			console.log("query:", JSON.stringify(query, null, 2));
			console.log("doctor:", doctorName, "doctorId:", data.doctor.id);
			console.log(
				"-------------------------------------------------------------",
			);
			return JSON.stringify({
				found: false,
				doctor: {
					doctorId: data.doctor.id,
					name: doctorName,
					cabinet: data.doctor.cabinetName,
					address: data.doctor.address ?? null,
				},
				message: "No available slots were found for this doctor.",
			});
		}

		const slots = data.slots.map((slot) => ({
			slotStart: slot.start,
			slotEnd: slot.end,
		}));

		console.log(
			"---------------------- find_doctor_slots OK ----------------------",
		);
		console.log("doctor:", doctorName, "doctorId:", data.doctor.id);
		console.log("returnedSlots:", slots.length);
		console.log("slots:", JSON.stringify(slots, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		return JSON.stringify({
			found: true,
			doctor: {
				doctorId: data.doctor.id,
				name: doctorName,
				cabinet: data.doctor.cabinetName,
				address: data.doctor.address ?? null,
			},
			slots,
		});
	}

	private async listMyAiAppointments(options?: {
		includeRecentPast?: boolean;
	}): Promise<string> {
		const callerRaw = this.ctx.callerPhone?.trim();
		if (!callerRaw) {
			return JSON.stringify({
				error: true,
				message: "list_my_ai_appointments: no caller phone on this call",
			});
		}
		const data = await listCallerAiAppointments(callerRaw, {
			includeRecentPast: options?.includeRecentPast,
		});
		return JSON.stringify({
			found: data.upcoming.length > 0 || data.recentPast.length > 0,
			upcoming: data.upcoming,
			recentPast: data.recentPast,
			message:
				"Times are UTC in JSON; tell the patient times in Tunisia GMT+1. For confirmed appointments, cancellation by phone is not allowed — patient must contact the doctor.",
		});
	}

	private async cancelAppointment(appointmentId: number): Promise<string> {
		const callerRaw = this.ctx.callerPhone?.trim();
		if (!callerRaw) {
			return JSON.stringify({
				error: true,
				message: "cancel_appointment: no caller phone on this call",
			});
		}
		try {
			const data = await cancelCallerAiAppointment(callerRaw, appointmentId);
			return JSON.stringify({
				success: true,
				appointment_id: data.appointmentId,
				status: data.status,
				message: "Appointment cancelled successfully.",
			});
		} catch (error: unknown) {
			const code =
				error &&
				typeof error === "object" &&
				"response" in error &&
				error.response &&
				typeof error.response === "object" &&
				"data" in error.response &&
				error.response.data &&
				typeof error.response.data === "object" &&
				"error" in error.response.data
					? String((error.response.data as { error: unknown }).error)
					: undefined;
			if (code === "APPOINTMENT_NOT_CANCELLABLE") {
				return JSON.stringify({
					error: true,
					code,
					message:
						"This appointment is already confirmed. The patient must contact the doctor's office to cancel or change it.",
				});
			}
			if (code === "FORBIDDEN" || code === "APPOINTMENT_NOT_FOUND") {
				return JSON.stringify({
					error: true,
					code,
					message: "That appointment was not found for this caller.",
				});
			}
			throw error;
		}
	}

	private async bookAppointment(
		params: BookAppointmentToolArgs,
	): Promise<string> {
		console.log(
			"---------------------- book_appointment INPUT ----------------------",
		);
		console.log(JSON.stringify(params, null, 2));
		console.log("callerPhone:", this.ctx.callerPhone);
		console.log(
			"-------------------------------------------------------------",
		);

		const callerRaw = this.ctx.callerPhone?.trim();
		if (!callerRaw) {
			const msg =
				"book_appointment: no caller phone on this call (Twilio From / callerPhone)";
			console.log(
				"---------------------- book_appointment VALIDATION ERROR ----------------------",
			);
			console.log(msg);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}
		const phoneNumber = phoneDigitsOnly(callerRaw);
		if (phoneNumber.length < 8) {
			const msg = `book_appointment: caller phone too short after normalization (${phoneNumber.length} digits)`;
			console.log(
				"---------------------- book_appointment VALIDATION ERROR ----------------------",
			);
			console.log("callerPhone:", callerRaw, "digits:", phoneNumber);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}

		const doctorId = Number(params.doctorId);
		if (
			!Number.isFinite(doctorId) ||
			doctorId <= 0 ||
			!Number.isInteger(doctorId)
		) {
			const msg = `Invalid doctorId: expected a positive integer (from find_available_slots doctorId), got ${JSON.stringify(params.doctorId)}`;
			console.log(
				"---------------------- book_appointment VALIDATION ERROR ----------------------",
			);
			console.log("params:", JSON.stringify(params, null, 2));
			console.log("doctorIdParsed:", doctorId);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}

		const body: BookAppointmentParams = {
			doctorId,
			name: params.patientName,
			phoneNumber,
			illness: params.illness,
			start: params.start,
			end: params.end,
		};

		const bookPath = "/api/appointments/external";
		console.log(
			"---------------------- book_appointment REQUEST ----------------------",
		);
		console.log("url:", `${nextjsApi.defaults.baseURL}${bookPath}`);
		console.log("body:", JSON.stringify(body, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const { data } = await nextjsApi.post(bookPath, body);

		console.log(
			"---------------------- book_appointment RESPONSE ----------------------",
		);
		console.log(data);
		console.log(
			"-------------------------------------------------------------",
		);

		// biome-ignore lint/suspicious/noExplicitAny: API row shape varies
		const row = data as any;
		const appointmentId = row?.id ?? row?._id;

		// Broadcast to dashboard
		if (this.ctx.callSid) {
			this.ctx.emit({
				type: "appointment_booked",
				callSid: this.ctx.callSid,
				data,
			});
			this.ctx.persistEvent({
				type: "appointment_booked",
				content: `Appointment #${appointmentId ?? "?"} booked`,
				functionResult: data,
			});
			this.ctx.persistCallUpdate({
				appointmentId: appointmentId ?? null,
				callerName: params.patientName,
			});
		}

		return JSON.stringify({
			success: true,
			appointment_id: appointmentId,
			status: row?.status,
			message: "Appointment created successfully with pending status.",
		});
	}

	private async bookEmergencyAppointments(
		params: BookEmergencyAppointmentsToolArgs,
	): Promise<string> {
		console.log(
			"---------------------- book_emergency_appointments INPUT ----------------------",
		);
		console.log(JSON.stringify(params, null, 2));
		console.log("callerPhone:", this.ctx.callerPhone);
		console.log(
			"-------------------------------------------------------------",
		);

		const callerRaw = this.ctx.callerPhone?.trim();
		if (!callerRaw) {
			return JSON.stringify({
				error: true,
				message:
					"book_emergency_appointments: no caller phone on this call (Twilio From / callerPhone)",
			});
		}

		const phoneNumber = phoneDigitsOnly(callerRaw);
		if (phoneNumber.length < 8) {
			return JSON.stringify({
				error: true,
				message: `book_emergency_appointments: caller phone too short after normalization (${phoneNumber.length} digits)`,
			});
		}

		const body = {
			speciality: params.specialitySlug,
			lat: params.latitude,
			long: params.longitude,
			name: params.patientName,
			phoneNumber,
			illness: params.illness,
		};

		const bookPath = "/api/appointments/external/emergency";
		console.log(
			"---------------------- book_emergency_appointments REQUEST ----------------------",
		);
		console.log("url:", `${nextjsApi.defaults.baseURL}${bookPath}`);
		console.log("body:", JSON.stringify(body, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const { data } = await nextjsApi.post<{
			found: boolean;
			emergencyGroupId?: string;
			appointments?: Array<{ id?: number; doctorId?: number }>;
			doctors?: Array<{
				doctorId: number;
				name: string;
				cabinet: string | null;
				address: string | null;
				distanceKm: number;
				slotStart: string;
				slotEnd: string;
			}>;
			message?: string;
		}>(bookPath, body);

		console.log(
			"---------------------- book_emergency_appointments RESPONSE ----------------------",
		);
		console.log(data);
		console.log(
			"-------------------------------------------------------------",
		);

		if (!data.found || !data.appointments?.length) {
			return JSON.stringify({
				success: false,
				found: false,
				message:
					data.message ??
					"No nearby doctors available for an urgent booking right now.",
			});
		}

		if (this.ctx.callSid) {
			for (const appt of data.appointments) {
				this.ctx.emit({
					type: "appointment_booked",
					callSid: this.ctx.callSid,
					data: {
						...appt,
						urgent: true,
						newPatientName: params.patientName,
					},
				});
			}
			this.ctx.persistEvent({
				type: "appointment_booked",
				content: `Urgent fan-out: ${data.appointments.length} pending appointment(s)`,
				functionResult: data,
			});
			this.ctx.persistCallUpdate({
				appointmentId: data.appointments[0]?.id ?? null,
				callerName: params.patientName,
			});
		}

		return JSON.stringify({
			success: true,
			found: true,
			emergency_group_id: data.emergencyGroupId,
			count: data.appointments.length,
			doctors: data.doctors,
			message:
				data.message ??
				"Urgent requests sent to nearby doctors. The first to accept keeps the appointment.",
		});
	}

	private async updatePersonInfo(
		params: UpdatePersonInfoToolArgs,
	): Promise<string> {
		console.log(
			"---------------------- update_person_info INPUT ----------------------",
		);
		console.log(JSON.stringify(params, null, 2));
		console.log("personId:", this.ctx.personId);
		console.log(
			"-------------------------------------------------------------",
		);

		if (this.ctx.personId == null && this.ctx.callerPhone) {
			console.log(
				"---------------------- update_person_info AWAITING PERSON ----------------------",
			);
			console.log("callerPhone:", this.ctx.callerPhone);
			console.log(
				"-------------------------------------------------------------",
			);
			const row = await ensurePersonRow(this.ctx.callerPhone);
			if (row != null) this.ctx.applyPersonRow(row);
		}

		if (this.ctx.personId == null) {
			const msg =
				"update_person_info: no person record for this caller (ensurePersonRow may still be pending)";
			console.log(
				"---------------------- update_person_info VALIDATION ERROR ----------------------",
			);
			console.log(msg);
			console.log("callerPhone:", this.ctx.callerPhone);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}

		const path = `/api/persons/${this.ctx.personId}`;
		console.log(
			"---------------------- update_person_info REQUEST ----------------------",
		);
		console.log("url:", `${nextjsApi.defaults.baseURL}${path}`);
		console.log("body:", JSON.stringify(params, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		const data = await updatePersonRow(this.ctx.personId, params);

		console.log(
			"---------------------- update_person_info RESPONSE ----------------------",
		);
		console.log(data);
		console.log(
			"-------------------------------------------------------------",
		);

		if (params.firstName?.trim() || params.preferredLanguage) {
			this.ctx.onProfileChange({
				firstName: params.firstName?.trim() || undefined,
				preferredLanguage: params.preferredLanguage,
			});
		}

		return JSON.stringify({
			success: true,
			person_id: data.id,
			message: "Person record updated successfully.",
		});
	}
}
