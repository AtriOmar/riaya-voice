/** Prompt text shared by every call path (Twilio media stream, LiveKit agent). */

import type { CallerRefusalContext } from "../api/callerAppointmentsApi.js";
import type { PersonOnLine } from "../api/callerPeopleApi.js";
import type { CallerPlace } from "../api/callerPlaceApi.js";
import { localSlot, toTunisLocal } from "../utils/tunisTime.js";

export type CallLanguage = "en" | "fr" | "ar";

export const LANGUAGE_LABEL: Record<CallLanguage, string> = {
	ar: "Tunisian Arabic (Derja)",
	fr: "French",
	en: "English",
};

export function buildInitialGreetingInstructions(
	lang: CallLanguage,
	firstName?: string | null,
): string {
	const name = firstName?.trim();
	const withName = name && name.length > 0;
	if (lang === "fr") {
		return withName
			? `Say exactly one short sentence in French greeting ${name} by first name, introduce yourself as Riaya, and ask how you can help. Do NOT mention appointments. Do NOT call any functions.`
			: 'Say exactly one short sentence in French: "Bonjour, ici Riaya. Comment puis-je vous aider?" Do NOT call any functions.';
	}
	if (lang === "ar") {
		return withName
			? `Say exactly one short sentence in Tunisian Arabic (Derja): "أهلا ${name}، معاك رعاية. شنوّا نجم نعاونك?" Do NOT mention appointments. Do NOT call any functions.`
			: 'Say exactly one short sentence in Tunisian Arabic (Derja): "أهلا، معاك رعاية. شنوّا نجم نعاونك?" Do NOT call any functions.';
	}
	return withName
		? `Say exactly one short sentence greeting ${name} by first name, say "Hello, this is Riaya," and ask how you can help. Do NOT mention appointments. Do NOT call any functions.`
		: 'Say exactly one short sentence: "Hello, this is Riaya. How can I help you?" Do NOT call any functions.';
}

/** What the call watchdog (`callWatchdog.ts`) needs the assistant to say. */
export type WatchdogPrompt =
	| "still_there"
	| "silent_goodbye"
	| "time_limit_goodbye";

export function buildWatchdogInstructions(
	prompt: WatchdogPrompt,
	lang: CallLanguage,
): string {
	const label = LANGUAGE_LABEL[lang];
	switch (prompt) {
		case "still_there":
			return `[System note] The caller has not said anything for a while. In one short sentence in ${label}, ask whether they are still there. Do not repeat your last question and do not call any functions.`;
		case "silent_goodbye":
			return `[System note] The caller is still silent, so this call is ending. In one short sentence in ${label}, say you could not hear them, invite them to call back, and say goodbye. Do not call any functions.`;
		case "time_limit_goodbye":
			return `[System note] The call time limit is reached and this call is ending now. In one short sentence in ${label}, apologise, invite them to call back to continue, and say goodbye. Do not call any functions.`;
	}
}

/** Why Riaya is calling the patient back. */
export type CallbackReason = "refused" | "timeout";

export function normalizeCallbackReason(raw: unknown): CallbackReason {
	return raw === "timeout" ? "timeout" : "refused";
}

/**
 * Opening line when Riaya placed the call. Short on purpose: one or two
 * sentences, one question. The detailed options come later in the conversation.
 */
export function buildCallbackGreetingInstructions(params: {
	lang: CallLanguage;
	firstName?: string | null;
	reason: CallbackReason;
	refusedDoctorName?: string | null;
}): string {
	const name = params.firstName?.trim();
	const what =
		params.reason === "refused"
			? params.refusedDoctorName
				? `Dr. ${params.refusedDoctorName} could not accept their appointment request`
				: "the doctor could not accept their appointment request"
			: "no doctor was able to confirm their appointment request in time";
	return `You placed this call. The patient just picked up. Speak in ${LANGUAGE_LABEL[params.lang]}.
Say at most two short sentences: ${name ? `greet ${name} by first name, ` : "greet them, "}say you are Riaya calling about their appointment request, and tell them ${what}.
Then ask ONE question: would they like you to find another doctor for them? Stop and wait for the answer.
Do NOT list doctors or times yet. Do NOT call any functions. Never read out a phone number.`;
}

function buildCallbackBlock(reason: CallbackReason): string {
	const why =
		reason === "refused"
			? "the doctor refused their appointment request"
			: "no doctor confirmed their appointment request in time, so it was cancelled";
	return `

## OUTBOUND CALLBACK (YOU CALLED THE PATIENT)
You, Riaya, placed this call because ${why}. The patient already has no appointment for that request.
- You already explained this in your opening line. Do not repeat it, and do not ask for their phone number.
- If they want another doctor, help them book one using the normal flow.
- If it is a wrong number (they never asked for an appointment), apologize briefly and call \`end_call\`. The caller may have booked for someone else (a child, a parent); that is not a wrong number.
- If they decline or are no longer interested, thank them and call \`end_call\`.
- If they ask something unrelated, answer briefly or help with a booking as usual.`;
}

/** Language of a call when the caller has none saved. */
export const DEFAULT_CALL_LANGUAGE: CallLanguage = "ar";

/** The language if `raw` is one we support, else null (nothing saved). */
export function parseCallLanguage(raw: unknown): CallLanguage | null {
	return raw === "en" || raw === "fr" || raw === "ar" ? raw : null;
}

export function normalizeCallLanguage(raw: unknown): CallLanguage {
	return parseCallLanguage(raw) ?? DEFAULT_CALL_LANGUAGE;
}

/**
 * Tool result for `end_call` / `report_abuse` once the hangup is scheduled: the
 * model says one goodbye line, then the call path hangs up.
 */
export function buildHangupToolResult(
	language: CallLanguage,
	reason: "done" | "abuse",
): string {
	const langHint =
		language === "fr"
			? "French"
			: language === "en"
				? "English"
				: "Tunisian Arabic (Derja)";
	const goodbye =
		reason === "abuse"
			? `Say one short, calm, neutral goodbye now (${langHint}). Do not mention any report, warning or block, and do not argue.`
			: `Say a brief thank-you and goodbye to the patient now (one short sentence, ${langHint}).`;
	return JSON.stringify({
		success: true,
		message: `Call disconnect is scheduled when this response finishes. ${goodbye} Do not call other tools.`,
	});
}

export type CallerProfile = {
	/** The caller's saved language; null when none is saved yet. */
	savedLanguage: CallLanguage | null;
	firstName?: string | null;
	callerPhone?: string | null;
	/** Everyone on the caller's phone (owner first); who an appointment can be for. */
	people?: PersonOnLine[];
	/** Set when a doctor recently refused this caller's request. */
	refusalContext?: CallerRefusalContext | null;
	/** Set when Riaya placed the call (outbound callback). */
	callbackReason?: CallbackReason | null;
	/** Place of this line's last phone booking, offered again at the location step. */
	lastPlace?: CallerPlace | null;
};

/** Rebook for the same patient and reason as the request not accepted, without asking again. */
function buildSameRequestLines(context: CallerRefusalContext): string {
	const lines: string[] = [];
	const p = context.patient;
	if (p) {
		const name = [p.firstName, p.lastName].filter(Boolean).join(" ");
		lines.push(
			`- The request was for **${name || "a person whose name is not on file"}** (\`patient_person_id\` **${p.personId}**). Book the alternative for them: pass that \`patient_person_id\`${name ? " and name" : ""}, and do not ask again who it is for.${name ? ` Say the name when you offer the doctors (e.g. "for ${p.firstName || name}"), so the caller can correct you if it is for someone else.` : ""}`,
		);
	}
	if (context.illness) {
		lines.push(
			`- The reason given was "${context.illness}". Reuse it as \`illness\` without asking again, unless the caller gives a new one.`,
		);
	}
	return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function buildRefusalBlock(
	context: CallerRefusalContext,
	isCallback: boolean,
): string {
	const doctors = context.suggestions
		.map(
			(s, i) =>
				`${i + 1}. doctor_id **${s.doctorId}** — ${s.name}${s.cabinetName ? `, ${s.cabinetName}` : ""}${s.address ? `, ${s.address}` : ""} (~${s.distanceKm} km); first slot ${slotLine(s)}`,
		)
		.join("\n");
	const refused = context.refusedDoctorName
		? `Dr. ${context.refusedDoctorName}`
		: "the doctor";
	const timedOut = context.reason === "timeout";
	const what = timedOut
		? "no doctor confirmed this caller's recent appointment request in time, so it was cancelled"
		: `a doctor recently **refused** this caller's appointment request (${refused})`;
	const sayWhat = timedOut
		? "no doctor could confirm the request in time"
		: `${refused} could not accept the request`;
	const sameRequest = buildSameRequestLines(context);
	return `

## RECENT REQUEST NOT ACCEPTED (THIS CALLER)
${what.charAt(0).toUpperCase()}${what.slice(1)}. ${isCallback ? "You are calling them about it." : "The caller was told to call back and may be calling about it."}
${isCallback ? "You already told them in the opening line. When they agree to another doctor, offer these alternatives (same speciality, near the same area), like normal options:" : `Do **not** mention this in the opening greeting. When the patient says they want an appointment, or asks what happened, say briefly that ${sayWhat}, then offer these alternatives (same speciality, near the same area), like normal options:`}
${doctors}${sameRequest}
- If the patient picks one, call \`book_appointment\` with that exact \`doctor_id\` and the listed slot's start and end as \`start\` / \`end\` (you may first call \`find_doctor_slots\` if they want another time).
- If they want a different speciality, location, or a specific doctor by name, follow the normal flow / \`find_doctor_by_name\`.
- Never invent doctors or times beyond this list and tool results.`;
}

/** A suggested slot in Tunisia local time, as the assistant reads it. */
function slotLine(s: { slotStart: string; slotEnd: string }): string {
	const slot = localSlot({ start: s.slotStart, end: s.slotEnd });
	return `${slot.when}: start \`${slot.slotStart}\`, end \`${slot.slotEnd}\``;
}

function buildCurrentTimeBlock(now: Date = new Date()): string {
	const local = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Africa/Tunis",
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	}).format(now);
	const clock = toTunisLocal(now);
	return `

## CURRENT DATE AND TIME
Now in Tunisia: **${local}, ${clock.slice(11)}** (\`${clock}\`).
Use this for "today", "tomorrow" and weekdays, and as \`preferred_time\` when the patient has no preference.`;
}

const RELATIONSHIP_LABEL: Record<PersonOnLine["relationship"], string> = {
	self: "the phone owner (usually the caller)",
	child: "child of the phone owner",
	parent: "parent of the phone owner",
	spouse: "spouse of the phone owner",
	sibling: "sibling of the phone owner",
	other: "family member of the phone owner",
};

function buildLastPlaceBlock(place: CallerPlace | null | undefined): string {
	// Without a name the assistant cannot ask about it, so it asks for the place as usual.
	if (!place?.label) return "";
	return `

## LAST BOOKING PLACE
This line last booked from near **${place.label}** (latitude ${place.latitude}, longitude ${place.longitude}).
At the location step, ask once whether the patient is in the same area as last time, naming the place. If yes, use these coordinates for \`find_available_slots\` or \`book_emergency_appointments\` and skip \`search_location\`. If no, ask for the place as usual. Do not mention it in the opening greeting.`;
}

function buildPeopleBlock(people: PersonOnLine[]): string {
	if (people.length === 0) return "";
	const lines = people
		.map((p) => {
			const name =
				[p.firstName, p.lastName].filter(Boolean).join(" ") ||
				"name not on file yet";
			return `- \`patient_person_id\` **${p.personId}**: ${name} — ${RELATIONSHIP_LABEL[p.relationship]}`;
		})
		.join("\n");
	return `

## PEOPLE ON THIS LINE
People already known on this phone. Use their \`patient_person_id\` when booking for one of them:
${lines}`;
}

const MIXING_IS_NOT_A_SWITCH =
	"Mixing a few French or English words into Derja is normal and is **not** a switch.";

function buildLanguageBlock(saved: CallLanguage | null): string {
	if (saved) {
		return `## CALLER LANGUAGE
Saved language for this caller: **${saved}** (${LANGUAGE_LABEL[saved]}). **Start and respond in it.**
If the caller asks for another language (English, French or Tunisian Derja), or keeps answering in another one, switch right away and call \`update_person_info\` with \`preferred_language\` (\`en\`, \`fr\`, or \`ar\` for Derja). ${MIXING_IS_NOT_A_SWITCH} Never call the tool for the saved language.`;
	}
	return `## CALLER LANGUAGE
No language is saved for this caller yet. You greet in Tunisian Derja; then reply in the language the caller answers in (English, French or Tunisian Derja). ${MIXING_IS_NOT_A_SWITCH}
Save it **once**, as soon as it is clear: add \`preferred_language\` (\`en\`, \`fr\`, or \`ar\` for Derja) to your first \`update_person_info\` call (usually the one that saves their name), or call it with just \`preferred_language\` if you have nothing else to save. After that, call it again only if the caller switches language.`;
}

/** Full session instructions: base system prompt + caller profile / language / phone blocks. */
export function buildCallInstructions(
	systemPrompt: string,
	profile: CallerProfile,
): string {
	const knownName = profile.firstName?.trim();
	const profileBlock = knownName
		? `Known first name of the phone owner: **${knownName}** (used in the greeting). Do not ask for it again unless the caller says they are someone else.`
		: "No name on file for the phone owner. Ask for the patient's name at step 2, once you know who the appointment is for.";
	const instructions = `${systemPrompt}${buildCurrentTimeBlock()}

## CALLER PROFILE
${profileBlock}

${buildLanguageBlock(profile.savedLanguage)}`;

	const callback = profile.callbackReason
		? buildCallbackBlock(profile.callbackReason)
		: "";
	if (!profile.callerPhone) return `${instructions}${callback}`;
	const withPhone = `${instructions}${callback}${buildPeopleBlock(profile.people ?? [])}${buildLastPlaceBlock(profile.lastPlace)}

## CALLER PHONE (THIS LINE)
The phone number for this call is: **${profile.callerPhone}**.
The server uses this number automatically when \`book_appointment\`, \`list_my_ai_appointments\`, or \`cancel_appointment\` runs. Do **not** ask the patient about their phone number.`;
	return profile.refusalContext
		? `${withPhone}${buildRefusalBlock(profile.refusalContext, Boolean(profile.callbackReason))}`
		: withPhone;
}
