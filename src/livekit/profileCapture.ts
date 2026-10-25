/**
 * Background capture of the caller's name and language preference.
 *
 * Why not a tool: with `update_person_info` in the conversation's tool list the
 * model calls it eagerly (even with nothing to save), and every tool call costs
 * a full extra language-model round trip (~1 s) before the reply. Here a small
 * model reads each caller sentence off the reply path, and saving happens in the
 * background, so the conversation model never waits on it.
 */

import type { CallLanguage } from "../sessions/callInstructions.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type ProfileFindings = {
	first_name?: string;
	last_name?: string;
	preferred_language?: "en" | "fr" | "ar";
};

const LANGUAGES = new Set(["en", "fr", "ar"]);

const NOT_A_SWITCH =
	"Mixing a few French or English words into Derja is NOT a switch.";

function languageRule(savedLanguage: CallLanguage | null): string {
	return savedLanguage
		? `preferred_language: only if the caller asks to switch to a different language than the saved one (${savedLanguage}; ar = Tunisian Derja), or answers in full sentences in another language. ${NOT_A_SWITCH} Otherwise null.`
		: `preferred_language: no language is saved yet, so give the language the caller speaks in this message (en, fr, or ar for Tunisian Derja), when it is clear. ${NOT_A_SWITCH} Otherwise null.`;
}

function buildSystemPrompt(savedLanguage: CallLanguage | null) {
	return [
		"You extract facts from one turn of a phone call to a doctor-appointment line in Tunisia.",
		'Reply with JSON only: {"first_name": string|null, "last_name": string|null, "preferred_language": "en"|"fr"|"ar"|null}.',
		"first_name / last_name: only if the caller says THEIR OWN name in this message (introducing themselves, or answering a question about their name). Never a doctor's, city's or speciality name, and never a name that is not the caller's. Keep it as spoken; write Arabic names in Arabic script. If only one name is given, put it in first_name. These names are saved as the phone owner's, so use null when the caller says this is someone else's phone (e.g. their husband's or mother's).",
		languageRule(savedLanguage),
		"Use null for anything not clearly present.",
	].join(" ");
}

export async function extractProfile(opts: {
	apiKey: string;
	model: string;
	assistantText: string;
	callerText: string;
	/** The caller's saved language; null when none is saved yet. */
	savedLanguage: CallLanguage | null;
	signal?: AbortSignal;
}): Promise<ProfileFindings> {
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: opts.model,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: buildSystemPrompt(opts.savedLanguage) },
				{
					role: "user",
					content: `Assistant said: "${opts.assistantText}"\nCaller said: "${opts.callerText}"`,
				},
			],
		}),
		signal: opts.signal,
	});
	if (!res.ok) {
		throw new Error(`Profile extraction failed: ${res.status}`);
	}
	const json = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
	} catch {
		return {};
	}
	const str = (v: unknown) =>
		typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
	const lang = str(parsed.preferred_language);
	return {
		first_name: str(parsed.first_name),
		last_name: str(parsed.last_name),
		preferred_language:
			lang && LANGUAGES.has(lang) ? (lang as "en" | "fr" | "ar") : undefined,
	};
}
