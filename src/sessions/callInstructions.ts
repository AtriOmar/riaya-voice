/** Prompt text shared by every call path (Twilio media stream, LiveKit agent). */

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

export function normalizeCallLanguage(raw: unknown): CallLanguage {
	if (raw === "en" || raw === "fr" || raw === "ar") return raw;
	return "ar";
}

export type CallerProfile = {
	language: CallLanguage;
	firstName?: string | null;
	callerPhone?: string | null;
};

/** Full session instructions: base system prompt + caller profile / language / phone blocks. */
export function buildCallInstructions(
	systemPrompt: string,
	profile: CallerProfile,
): string {
	const lang = profile.language;
	const langLabel = LANGUAGE_LABEL[lang];
	const knownName = profile.firstName?.trim();
	const profileBlock = knownName
		? `Known first name: **${knownName}** (use in greeting; you may skip asking for name unless unclear).`
		: "Name not on file yet — ask for their name early in the booking flow.";
	const instructions = `${systemPrompt}

## CALLER PROFILE
${profileBlock}
Do **not** mention existing appointments in the opening greeting. Use \`list_my_ai_appointments\` only when the patient asks about a booking, doctor, location, time, or cancellation.

## CALLER LANGUAGE PREFERENCE
Stored preference for this caller: **${lang}** (${langLabel}). **Start and respond in this language** until the patient asks to switch.
If they ask to speak a language **different from ${lang}** (English, French, or Tunisian Derja), switch immediately and call \`update_person_info\` with \`preferred_language\` set to \`en\`, \`fr\`, or \`ar\` (use \`ar\` for Tunisian Derja). Mixing a few French or English words into Derja is normal and is **not** a language switch; do not call the tool for it.`;

	if (!profile.callerPhone) return instructions;
	return `${instructions}

## CALLER PHONE (THIS LINE)
The phone number for this call is: **${profile.callerPhone}**.
The server uses this number automatically when \`book_appointment\`, \`list_my_ai_appointments\`, or \`cancel_appointment\` runs. Do **not** ask the patient about their phone number.`;
}
