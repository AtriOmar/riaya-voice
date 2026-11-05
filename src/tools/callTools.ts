import axios from "axios";
import type { Logger } from "pino";
import { callReportCategories, reportAbusiveCall } from "../api/abuseApi.js";
import {
	type CallerAiAppointmentItem,
	type CallerRefusalContext,
	cancelCallerAiAppointment,
	listCallerAiAppointments,
	REFUSAL_OFFER_COUNT,
	refusalSlotIndex,
} from "../api/callerAppointmentsApi.js";
import type { PersonRelationship } from "../api/callerPeopleApi.js";
import type { CallerPlace } from "../api/callerPlaceApi.js";
import type { createCallEvent, updateCall } from "../api/callsApi.js";
import { nextjsApi } from "../api/nextjsApiClient.js";
import { ensurePersonRow, updatePersonRow } from "../api/personsApi.js";
import { CITIES } from "../constants/cities.js";
import type { CallLanguage } from "../sessions/callInstructions.js";
import type {
	BestFitDoctor,
	BookAppointmentParams,
	DashboardMessage,
	DoctorAvailabilityResponse,
} from "../types/index.js";
import {
	fromTunisLocal,
	localSlot,
	toTunisLocal,
	tunisLabel,
} from "../utils/tunisTime.js";
import { findPlaces, type PlaceSearchResult } from "./locationSearch.js";

/**
 * Booking tools shared by every call path (Twilio media stream session and the
 * LiveKit agent). The call path owns the per-call state and exposes it through
 * `CallToolsContext`. Hanging up (`end_call`, and after `report_abuse`) stays
 * with the call path since it is transport-specific.
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
	/** Place of this line's last phone booking, offered again at the location step. */
	readonly lastPlace: CallerPlace | null;
	/** The doctors suggested after a refused request; their slots are bookable as `refusalSlotId`. */
	readonly refusalContext: CallerRefusalContext | null;
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

/** Coordinates rounded to about 10 m, so the same place matches even if the model rounds them. */
function placeKey(latitude: number, longitude: number): string {
	return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

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

/** The web API's error code (`{ error: "CODE" }` body), if this is one. */
function apiErrorCode(error: unknown): string | undefined {
	if (!axios.isAxiosError(error)) return undefined;
	const data = error.response?.data as { error?: unknown } | undefined;
	return typeof data?.error === "string" ? data.error : undefined;
}

/**
 * What the assistant should do next when a booking or search is refused, by
 * API error code. Codes not listed here are real failures and are thrown.
 */
const TOOL_ERROR_NEXT_STEP: Record<string, string> = {
	APPOINTMENT_CONFLICT:
		"That time was just taken by someone else. Tell the patient in one short sentence, call find_doctor_slots for the same doctor_id with preferred_time set to the time they wanted, and offer the next free time. If that does not suit them, offer the other doctors from the search.",
	DOCTOR_UNAVAILABLE_DAY:
		"That day is outside this doctor's opening hours. Book only a slot returned by find_available_slots or find_doctor_slots: call find_doctor_slots for this doctor_id and offer one of its times.",
	DOCTOR_UNAVAILABLE_TIME:
		"That time is outside this doctor's opening hours. Book only a slot returned by find_available_slots or find_doctor_slots: call find_doctor_slots for this doctor_id and offer one of its times.",
	INVALID_TIME_RANGE:
		"That slot is not a valid time range. Call find_doctor_slots for the same doctor_id and offer one of its slots.",
	VALIDATION_ERROR:
		"Some fields were invalid. Use the exact slotId from the tool result, and the patient's first name.",
	DOCTOR_NOT_FOUND:
		"That doctor_id does not exist. Use the doctorId from the search result for the doctor the patient chose.",
	PERSON_NOT_ON_PHONE:
		"That patient_person_id is not on this phone. Use a patient_person_id from PEOPLE ON THIS LINE, or book them as a new family member (patient_relationship, no patient_person_id).",
	SPECIALITY_NOT_FOUND:
		"That speciality_slug does not exist. Use one of the slugs in Specialities.",
};

/** The tool result for a known API refusal, or null to let the error through. */
function toolErrorResult(error: unknown): string | null {
	const code = apiErrorCode(error);
	const nextStep = code ? TOOL_ERROR_NEXT_STEP[code] : undefined;
	return nextStep
		? JSON.stringify({ error: true, code, message: nextStep })
		: null;
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
	/** The patient wants doctors other than the ones already offered. */
	otherDoctors?: boolean;
};

/** Doctors a search finds: three pairs, handed to the AI two at a time. */
const SLOT_SEARCH_RESULTS = 6;

/** Doctors the AI gets per turn, so it never has one to read that it was not meant to offer. */
const DOCTORS_PER_TURN = 2;

/**
 * Where a slot search started, in words, so the model can see which days it covered.
 * A search without a preferred time starts now.
 */
function searchedFrom(preferredTime: string | undefined): string {
	return tunisLabel(preferredTime ?? new Date());
}

type FindDoctorSlotsArgs = {
	doctorId: number;
	preferredTime?: string;
	limit?: number;
};

/** Who a booking is for: someone on the line (`personId`), a new family member, or (neither) the phone owner. */
type BookingPatient = {
	personId?: number;
	firstName: string;
	lastName?: string;
	relationship?: Exclude<PersonRelationship, "self">;
};

type BookAppointmentToolArgs = {
	slotId: string;
	patient: BookingPatient;
	illness: string;
};

/** A slot a search offered, as booked through its id. Times are UTC ISO strings. */
type OfferedSlot = { doctorId: number; start: string; end: string };

type BookEmergencyAppointmentsToolArgs = {
	specialitySlug: string;
	latitude: number;
	longitude: number;
	patient: BookingPatient;
	illness: string;
};

const FAMILY_RELATIONSHIPS = [
	"child",
	"parent",
	"spouse",
	"sibling",
	"other",
] as const satisfies readonly Exclude<PersonRelationship, "self">[];

/** One of the caller's appointments with Tunisia local times, as the assistant gets it. */
function localAppointment(a: CallerAiAppointmentItem) {
	return {
		...a,
		start: a.start ? toTunisLocal(a.start) : null,
		end: a.end ? toTunisLocal(a.end) : null,
		when: a.start ? tunisLabel(a.start) : null,
	};
}

/** Full name for logs and dashboard events. */
function bookingPatientName(p: BookingPatient): string {
	return [p.firstName, p.lastName].filter(Boolean).join(" ");
}

/**
 * Read the `patient_*` tool arguments. Needs a first name. `patient_person_id` picks
 * someone on the line, `patient_relationship` adds a new family member, and with
 * neither the booking is for the phone owner.
 */
function parseBookingPatient(
	o: Record<string, unknown>,
): BookingPatient | null {
	const firstName = strField(o, "patient_first_name", "patientFirstName");
	if (firstName === undefined) return null;
	const lastName = strField(o, "patient_last_name", "patientLastName");

	const rawId = o.patient_person_id ?? o.patientPersonId;
	const personId = Number(rawId);
	if (
		rawId != null &&
		rawId !== "" &&
		Number.isInteger(personId) &&
		personId > 0
	) {
		return { personId, firstName, lastName };
	}

	const relationship = strField(
		o,
		"patient_relationship",
		"patientRelationship",
	);
	if (relationship === undefined) return { firstName, lastName };
	const family = FAMILY_RELATIONSHIPS.find((r) => r === relationship);
	if (!family) return null;
	return { firstName, lastName, relationship: family };
}

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
	const preferredLocal = strField(o, "preferred_time", "preferredTime");
	const preferredTime =
		preferredLocal !== undefined ? fromTunisLocal(preferredLocal) : undefined;
	if (latitude === undefined || longitude === undefined) return null;
	if (preferredTime === null) return null;
	const otherDoctors = o.other_doctors === true || o.otherDoctors === true;
	return {
		specialitySlug,
		latitude,
		longitude,
		...(preferredTime !== undefined ? { preferredTime } : {}),
		...(otherDoctors ? { otherDoctors } : {}),
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
	const preferredLocal = strField(o, "preferred_time", "preferredTime");
	const preferredTime =
		preferredLocal !== undefined ? fromTunisLocal(preferredLocal) : undefined;
	if (preferredTime === null) return null;
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
	const patient = parseBookingPatient(o);
	const illness = strField(o, "illness", "illness");
	const slotId = strField(o, "slot_id", "slotId");
	if (patient === null || illness === undefined || slotId === undefined) {
		return null;
	}
	return { slotId, patient, illness };
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
	const patient = parseBookingPatient(o);
	const illness = strField(o, "illness", "illness");
	if (
		specialitySlug === undefined ||
		latitude === undefined ||
		longitude === undefined ||
		patient === null ||
		illness === undefined
	) {
		return null;
	}
	return { specialitySlug, latitude, longitude, patient, illness };
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
	const dateOfBirthRaw = strField(o, "date_of_birth", "dateOfBirth");
	// A birth date has no time of day: store it as midnight UTC, as the API expects.
	const dateOfBirth =
		dateOfBirthRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirthRaw)
			? `${dateOfBirthRaw}T00:00:00.000Z`
			: dateOfBirthRaw;
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
	/** Names of the places `search_location` returned on this call, by coordinates. */
	private readonly placeLabels = new Map<string, string>();
	/** The place of the last doctor search, saved on the booking. */
	private searchPlace: CallerPlace | null = null;
	/** Slots offered on this call, by the id the model books them with. */
	private readonly slots = new Map<string, OfferedSlot>();
	/** Doctors the AI was given to offer on this call: left out when the patient wants other doctors. */
	private readonly offeredDoctorIds = new Set<number>();
	/** The doctors of the last search not yet given to the AI, best first. */
	private heldBack: BestFitDoctor[] = [];
	/** The preferred time of the search `heldBack` came from. */
	private heldBackFrom: string | undefined;

	constructor(private readonly ctx: CallToolsContext) {}

	/**
	 * Gives a slot the search found an id for the model to book it with, so it never
	 * has to copy a time. The same slot found again keeps its id.
	 */
	private offerSlot(
		doctorId: number,
		slot: { start: string; end: string },
	): { slotId: string; when: string } {
		for (const [id, offered] of this.slots) {
			if (offered.doctorId === doctorId && offered.start === slot.start) {
				return { slotId: id, when: tunisLabel(slot.start) };
			}
		}
		const slotId = `s${this.slots.size + 1}`;
		this.slots.set(slotId, { doctorId, start: slot.start, end: slot.end });
		return { slotId, when: tunisLabel(slot.start) };
	}

	/** A slot offered on this call: by a search, or as an alternative after a refused request. */
	private findSlot(slotId: string): OfferedSlot | null {
		const found = this.slots.get(slotId);
		if (found) return found;
		const index = refusalSlotIndex(slotId);
		const suggestion =
			index === null ? undefined : this.ctx.refusalContext?.suggestions[index];
		return suggestion
			? {
					doctorId: suggestion.doctorId,
					start: suggestion.slotStart,
					end: suggestion.slotEnd,
				}
			: null;
	}

	/** The place at these coordinates, named when it came from a search, the last booking or the city list. */
	private placeAt(latitude: number, longitude: number): CallerPlace {
		const key = placeKey(latitude, longitude);
		const last = this.ctx.lastPlace;
		const label =
			this.placeLabels.get(key) ??
			(last && placeKey(last.latitude, last.longitude) === key
				? last.label
				: null) ??
			CITIES.find((c) => placeKey(c.latitude, c.longitude) === key)?.en_name ??
			null;
		return { label, latitude, longitude };
	}

	/**
	 * Runs one tool (everything except `end_call`) and returns the JSON string fed
	 * back to the model. A known API refusal (slot taken, unknown speciality, …)
	 * comes back as a next step for the model; any other failure is thrown.
	 */
	async run(
		name: string,
		parsedArgs: unknown,
		call_id?: string,
	): Promise<string> {
		try {
			return await this.dispatch(name, parsedArgs, call_id);
		} catch (error) {
			const result = toolErrorResult(error);
			if (result) {
				this.ctx.logger.info(
					{ tool: name, code: apiErrorCode(error) },
					"Tool refused by the API; next step sent to the model",
				);
				return result;
			}
			throw error;
		}
	}

	private async dispatch(
		name: string,
		parsedArgs: unknown,
		call_id?: string,
	): Promise<string> {
		let result: string;
		switch (name) {
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
							"find_available_slots: invalid arguments (expected speciality_slug, latitude, longitude, optional preferred_time as Tunisia local time YYYY-MM-DDTHH:mm)",
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
							"find_doctor_slots: invalid arguments (expected doctor_id, optional preferred_time as Tunisia local time YYYY-MM-DDTHH:mm, optional limit)",
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
							"book_appointment: invalid arguments (expected slot_id (the slotId of the chosen slot, exactly as returned), patient_first_name, illness)",
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
							"book_emergency_appointments: invalid arguments (expected speciality_slug, latitude, longitude, patient_first_name, illness)",
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
				// Defaults to true, as the tool schema says.
				const includeRecentPast = !(
					parsedArgs !== null &&
					typeof parsedArgs === "object" &&
					!Array.isArray(parsedArgs) &&
					(parsedArgs as { include_recent_past?: boolean })
						.include_recent_past === false
				);
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
			case "report_abuse":
				result = await this.reportAbuse(parsedArgs);
				break;
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
		// A city alone is too broad to find the nearest doctors: ask for the area first.
		const queryCity = findCityByName(query);
		if (queryCity) {
			return JSON.stringify({
				found: false,
				cityOnly: true,
				city: {
					en_name: queryCity.en_name,
					fr_name: queryCity.fr_name,
					ar_name: queryCity.ar_name,
					latitude: queryCity.latitude,
					longitude: queryCity.longitude,
				},
				message:
					"This is only a city. Ask the patient once for their neighbourhood, street or a landmark near them in this city, then search again. If they cannot give one, use these city coordinates.",
			});
		}
		try {
			const cityMatch = findCityByName(city);
			// The Next app picks the provider (GEO_PROVIDER); we only ask for places.
			const search =
				(near?: { lat: number; lng: number }, radiusM?: number) =>
				async (text: string) =>
					(
						await nextjsApi.get<PlaceSearchResult[]>(
							"/api/internal/places/search",
							{
								params: {
									text,
									...(near ? { lat: near.lat, lng: near.lng } : {}),
									...(radiusM ? { radiusM } : {}),
								},
							},
						)
					).data;
			const near = cityMatch
				? { lat: cityMatch.latitude, lng: cityMatch.longitude }
				: undefined;

			const places = await findPlaces({
				city,
				spoken: query,
				lookup: search(near, near ? CITY_SEARCH_RADIUS_M : undefined),
				widerLookup: near ? search(near) : undefined,
				apiKey: process.env.OPENROUTER_API_KEY,
				logger: this.ctx.logger,
			});

			if (places.length === 0) {
				return JSON.stringify({
					found: false,
					message:
						"No results found. Please ask the patient for more context (e.g., region, city).",
				});
			}

			for (const p of places) {
				if (p.lat !== null && p.lng !== null)
					this.placeLabels.set(placeKey(p.lat, p.lng), p.label);
			}

			const results = places.map((p) => ({
				name: p.label,
				city: p.city,
				state: p.state,
				street: p.street,
				latitude: p.lat,
				longitude: p.lng,
			}));

			return JSON.stringify({
				found: true,
				results,
				message:
					results.length > 1
						? "Multiple results found. Ask the patient which one they mean, naming each option by what tells it apart (its city, area or street). If you cannot tell the options apart, do not ask: proceed with the first one."
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

	private async findAvailableSlots(
		params: FindAvailableSlotsArgs,
	): Promise<string> {
		this.searchPlace = this.placeAt(params.latitude, params.longitude);
		const path = "/api/doctors/best-fit";
		const refusal = this.ctx.refusalContext;
		if (params.otherDoctors && this.heldBack.length > 0) {
			return this.nextDoctors();
		}

		// Doctors who could not accept the refused request are never offered again.
		const excluded = new Set(refusal?.refusedDoctorIds);
		if (params.otherDoctors) {
			for (const id of this.offeredDoctorIds) excluded.add(id);
			for (const s of refusal?.suggestions.slice(0, REFUSAL_OFFER_COUNT) ?? []) {
				excluded.add(s.doctorId);
			}
		}

		// Next route expects query keys: speciality, lat, long, time, exclude
		const query = {
			speciality: params.specialitySlug,
			lat: params.latitude,
			long: params.longitude,
			time: params.preferredTime,
			exclude: excluded.size > 0 ? [...excluded].join(",") : undefined,
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
				searchedFrom: searchedFrom(params.preferredTime),
				message: params.otherDoctors
					? "No other doctors with available slots were found for this speciality and location, besides the ones already offered."
					: "No doctors with available slots were found for this speciality and location.",
			});
		}

		// Best first (doctorId = doctorProfile.id for book_appointment)
		this.heldBack = data.slice(0, SLOT_SEARCH_RESULTS);
		this.heldBackFrom = params.preferredTime;
		return this.nextDoctors();
	}

	/**
	 * The next best doctors of the last search, two per turn. Only these count as offered,
	 * so the doctors held back stay available when the patient asks for others.
	 */
	private nextDoctors(): string {
		const page = this.heldBack.splice(0, DOCTORS_PER_TURN);
		for (const doc of page) this.offeredDoctorIds.add(doc.id);

		const top = page.map((doc) => ({
			doctorId: doc.id,
			name: `Dr. ${doc.firstName} ${doc.lastName}`,
			cabinet: doc.cabinetName,
			address: doc.address ?? null,
			distanceKm: Math.round((doc.roadDistanceKm ?? doc.distance) * 10) / 10,
			// Far fallback: tell the patient the doctor is outside the usual area.
			...(doc.outsideRadius ? { farAway: true } : {}),
			...this.offerSlot(doc.id, doc.nextSlot),
			// Additional nearby slots so the AI can offer alternatives without
			// a second find_available_slots call.
			// Other times only: the search lists the main slot among them too.
			nearbySlots: (doc.nearbySlots ?? [])
				.filter((slot) => slot.start !== doc.nextSlot.start)
				.map((slot) => this.offerSlot(doc.id, slot)),
		}));

		console.log(
			"---------------------- find_available_slots OK ----------------------",
		);
		console.log("returned:", top.length, "heldBack:", this.heldBack.length);
		console.log(
			"doctorIds:",
			top.map((d) => d.doctorId),
		);
		console.log("top:", JSON.stringify(top, null, 2));
		console.log(
			"-------------------------------------------------------------",
		);

		return JSON.stringify({
			found: true,
			searchedFrom: searchedFrom(this.heldBackFrom),
			doctors: top,
		});
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
				searchedFrom: searchedFrom(params.preferredTime),
				message:
					"No available slots were found for this doctor from the time searched.",
			});
		}

		const slots = data.slots.map((slot) =>
			this.offerSlot(data.doctor.id, slot),
		);

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
			searchedFrom: searchedFrom(params.preferredTime),
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
			upcoming: data.upcoming.map(localAppointment),
			recentPast: data.recentPast.map(localAppointment),
			message:
				"Times are Tunisia local time (when = in words). For confirmed appointments, cancellation by phone is not allowed — patient must contact the doctor.",
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
			const code = apiErrorCode(error);
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

	/**
	 * Files the abuse report for the admins. Never throws: the call path hangs up
	 * whatever happens here, so a failed report must not keep an abuser on the line.
	 */
	private async reportAbuse(parsedArgs: unknown): Promise<string> {
		const args = (parsedArgs ?? {}) as {
			category?: unknown;
			summary?: unknown;
		};
		const category = callReportCategories.find((c) => c === args.category);
		const summary =
			typeof args.summary === "string"
				? args.summary.trim().slice(0, 1000)
				: "";
		const callSid = this.ctx.callSid;
		const phoneNumber = this.ctx.callerPhone?.trim();
		if (!callSid || !phoneNumber) {
			this.ctx.logger.warn(
				{ callSid, hasPhone: Boolean(phoneNumber) },
				"report_abuse: no call or caller phone, report skipped",
			);
			return JSON.stringify({ reported: false });
		}
		try {
			const report = await reportAbusiveCall({
				callSid,
				phoneNumber,
				category: category ?? "other",
				summary: summary || "No summary given.",
			});
			this.ctx.logger.info(
				{ callSid, reportId: report.id, category },
				"🚩 Abusive call reported",
			);
			return JSON.stringify({ reported: true });
		} catch (err) {
			this.ctx.logger.error({ err, callSid }, "report_abuse: report failed");
			return JSON.stringify({ reported: false });
		}
	}

	/** Name the call after the caller only when the booking is for the caller themselves. */
	private callerNameIfSelf(patient: BookingPatient): { callerName?: string } {
		const isOwner =
			patient.personId != null
				? patient.personId === this.ctx.personId
				: patient.relationship === undefined;
		return isOwner ? { callerName: bookingPatientName(patient) } : {};
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
		const callerDigits = phoneDigitsOnly(callerRaw);
		if (callerDigits.length < 8) {
			const msg = `book_appointment: caller phone too short after normalization (${callerDigits.length} digits)`;
			console.log(
				"---------------------- book_appointment VALIDATION ERROR ----------------------",
			);
			console.log("callerPhone:", callerRaw, "digits:", callerDigits);
			console.log(
				"-------------------------------------------------------------",
			);
			throw new Error(msg);
		}

		const slot = this.findSlot(params.slotId);
		if (!slot) {
			console.log(
				"---------------------- book_appointment UNKNOWN SLOT ----------------------",
			);
			console.log("slotId:", params.slotId);
			console.log(
				"-------------------------------------------------------------",
			);
			return JSON.stringify({
				error: true,
				message: `Unknown slot_id ${JSON.stringify(params.slotId)}. Use the slotId of a slot a search returned on this call, exactly as given.`,
			});
		}

		const body: BookAppointmentParams = {
			doctorId: slot.doctorId,
			phoneNumber: callerRaw,
			patient: params.patient,
			illness: params.illness,
			start: slot.start,
			end: slot.end,
			...(this.searchPlace
				? {
						patientPlace: {
							label: this.searchPlace.label,
							lat: this.searchPlace.latitude,
							long: this.searchPlace.longitude,
						},
					}
				: {}),
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
				data: { ...data, patientName: bookingPatientName(params.patient) },
			});
			this.ctx.persistEvent({
				type: "appointment_booked",
				content: `Appointment #${appointmentId ?? "?"} booked`,
				functionResult: data,
			});
			this.ctx.persistCallUpdate({
				appointmentId: appointmentId ?? null,
				...this.callerNameIfSelf(params.patient),
			});
		}

		return JSON.stringify({
			success: true,
			appointment_id: appointmentId,
			patient_person_id: row?.personId,
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

		const callerDigits = phoneDigitsOnly(callerRaw);
		if (callerDigits.length < 8) {
			return JSON.stringify({
				error: true,
				message: `book_emergency_appointments: caller phone too short after normalization (${callerDigits.length} digits)`,
			});
		}

		const body = {
			speciality: params.specialitySlug,
			lat: params.latitude,
			long: params.longitude,
			placeLabel: this.placeAt(params.latitude, params.longitude).label,
			phoneNumber: callerRaw,
			patient: params.patient,
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
			appointments?: Array<{
				id?: number;
				doctorId?: number;
				personId?: number;
			}>;
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
					"No nearby doctor has a free slot in the next few hours, so no urgent request was sent.",
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
						patientName: bookingPatientName(params.patient),
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
				...this.callerNameIfSelf(params.patient),
			});
		}

		return JSON.stringify({
			success: true,
			found: true,
			emergency_group_id: data.emergencyGroupId,
			// Any one of these cancels the whole group if the patient changes their mind.
			appointment_ids: data.appointments.flatMap((a) =>
				a.id != null ? [a.id] : [],
			),
			patient_person_id: data.appointments[0]?.personId,
			count: data.appointments.length,
			doctors: data.doctors?.map(({ slotStart, slotEnd, ...doctor }) => ({
				...doctor,
				...localSlot({ start: slotStart, end: slotEnd }),
			})),
			message:
				data.message ??
				"Urgent requests sent to nearby doctors. The first to accept keeps the appointment; if none accepts within a few minutes, more doctors are asked.",
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
