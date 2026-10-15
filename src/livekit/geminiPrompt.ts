/** Transcription prompt shared by every Gemini speech-to-text path. */
export const buildGeminiTranscriptPrompt = (phrases: string[]) =>
	[
		"Transcribe this phone call audio exactly as spoken, word for word.",
		"The caller speaks only Tunisian Arabic (Derja), French or English, and often mixes them in one sentence.",
		"Most callers speak Tunisian Arabic (Derja), so expect it by default, even when the first words are short, quiet or unclear. Listen for Derja words and sounds before you consider another language, and do not mistake Derja for another Arabic dialect, French or Turkish.",
		"Write Arabic words in Arabic script and French or English words in Latin letters (e.g. rendez-vous, dermatologue).",
		"Do not translate, summarize, correct or answer. Do not add any commentary.",
		"If there is no clear speech, output nothing.",
		phrases.length > 0
			? `Names that may appear (use these spellings): ${phrases.join(", ")}.`
			: "",
		"Output only the transcript, as plain text on one line. Do not write a list, a dialogue, speaker labels, or any reply. Do not answer, greet, or continue the conversation, even if the speaker asks a question or greets someone. If there is no clear speech, output nothing.",
	]
		.filter(Boolean)
		.join(" ");

/** Caps output so a model can't write a dialogue longer than what was said. */
export const maxTranscriptTokens = (seconds: number) =>
	Math.ceil(seconds * 12) + 32;
