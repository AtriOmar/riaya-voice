/**
 * Finding the patient's area from what they said.
 *
 * The conversation model passes the place as heard, often Tunisian Arabic in
 * Arabic script, and possibly misheard. One romanization of it ("hay el ons")
 * rarely matches the map data, which names places in French ("Cité El Ons")
 * and sometimes in Arabic. So a small model can write several search texts in
 * both scripts, searched in parallel (`LOCATION_SEARCH_REWRITE=on`). By default
 * only the text as heard is searched, which keeps a metered geocoder to one
 * request per search. The same model then keeps only the results that are the
 * place the patient named. Without OPENROUTER_API_KEY, or when the small model
 * fails, the results of the text as heard are returned as they are.
 */

import type { Logger } from "pino";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL =
	process.env.LOCATION_SEARCH_MODEL?.trim() || "google/gemini-3.1-flash-lite";
/** Each model call gives up after this; the search then goes on without it. */
const MODEL_TIMEOUT_MS = 4000;
/** Whether the small model writes extra search texts besides the one heard. */
const REWRITE =
	process.env.LOCATION_SEARCH_REWRITE?.trim().toLowerCase() === "on";
const MAX_QUERIES = 5;
/** Candidates shown to the reviewing model. */
const MAX_CANDIDATES = 15;
const MAX_RESULTS = 5;

/** Row from `GET /api/internal/places/search` (see web `lib/geo`). */
export type PlaceSearchResult = {
	id: string;
	label: string;
	lat: number | null;
	lng: number | null;
	city: string | null;
	state: string | null;
	street: string | null;
};

/** One geocoder lookup of a search text. */
export type PlaceLookup = (text: string) => Promise<PlaceSearchResult[]>;

const WRITE_PROMPT = [
	"You write search texts for a geocoder (Tunisia only) to find the place a patient named on a phone call to a doctor-appointment line.",
	"The place comes from speech recognition: it may be misheard or misspelled, and may be in Tunisian Arabic (Arabic script), French, or a romanization.",
	"Map data names places in French and Latin letters, and sometimes in Arabic.",
	`Reply with JSON only: {"queries": string[]}, at most ${MAX_QUERIES} texts, each ending with ", <city>" written in the same script as the text.`,
	"Cover: the Arabic-script form with standard spelling (add the hamza: الانس → الأنس); the French form (حي → Cité, نهج → Rue, شارع → Avenue, جامع → Mosquée, مستشفى → Hôpital); the name without its prefix (حي, Cité, Hay); and, if a word looks misheard, the likeliest intended word.",
	"Keep proper names as names; never translate them into a different name. No explanations.",
	'Example: city "Tunis", place "حي الانس" → {"queries": ["حي الأنس, تونس", "الأنس, تونس", "Cité El Ons, Tunis", "El Ons, Tunis", "Hay El Ons, Tunis"]}',
].join(" ");

function reviewPrompt(city: string, spoken: string): string {
	return [
		`A patient on a phone call named a place in ${city}, Tunisia, heard by speech recognition as: "${spoken}".`,
		"The user message lists numbered geocoder results.",
		"Keep only results that are the place they named: the same name in any script or spelling (الأنس = El Ons = Elons), allowing for a word misheard by speech recognition.",
		"Drop results that only share a common word (Cité, Rue, Hay, El, حي) or are a different place.",
		`Order the kept results best first: a neighbourhood or landmark with that name before a street or building that only carries the name, and places in or near ${city} before others.`,
		'Reply with JSON only: {"matches": number[]} with the result numbers, or {"matches": []} if none is that place.',
	].join(" ");
}

async function askJson(
	apiKey: string,
	system: string,
	user: string,
): Promise<Record<string, unknown>> {
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: MODEL,
			temperature: 0,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		}),
		signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`Location model failed: ${res.status}`);
	const json = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	return JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
}

async function writeQueries(
	apiKey: string,
	city: string,
	spoken: string,
): Promise<string[]> {
	const out = await askJson(
		apiKey,
		WRITE_PROMPT,
		`City: "${city}". Place: "${spoken}".`,
	);
	if (!Array.isArray(out.queries)) return [];
	return out.queries
		.filter((q): q is string => typeof q === "string" && q.trim() !== "")
		.map((q) => q.trim())
		.slice(0, MAX_QUERIES);
}

/** The candidates the model kept, best first; throws on a reply without `matches`. */
async function reviewCandidates(
	apiKey: string,
	city: string,
	spoken: string,
	candidates: PlaceSearchResult[],
): Promise<PlaceSearchResult[]> {
	const list = candidates.map((p, i) => `${i + 1}. ${p.label}`).join("\n");
	const out = await askJson(apiKey, reviewPrompt(city, spoken), list);
	if (!Array.isArray(out.matches)) throw new Error("No matches in reply");
	const picked: PlaceSearchResult[] = [];
	for (const n of out.matches) {
		const place = typeof n === "number" ? candidates[n - 1] : undefined;
		if (place && !picked.includes(place)) picked.push(place);
	}
	return picked;
}

/**
 * Every distinct place the texts returned, the ones more texts agree on first.
 * Throws when every lookup failed, so an API outage is not taken for "no match".
 */
async function lookUpAll(
	texts: string[],
	lookup: PlaceLookup,
	first?: Promise<PlaceSearchResult[]>,
): Promise<PlaceSearchResult[]> {
	const settled = await Promise.allSettled(
		texts.map((t, i) => (i === 0 && first ? first : lookup(t))),
	);
	const failed = settled.filter((s) => s.status === "rejected");
	if (failed.length === settled.length) throw failed[0].reason;

	const hits = new Map<string, { place: PlaceSearchResult; count: number }>();
	for (const s of settled) {
		if (s.status !== "fulfilled") continue;
		for (const place of s.value) {
			if (place.lat === null || place.lng === null) continue;
			const key = place.id || `${place.lat},${place.lng}`;
			const hit = hits.get(key);
			if (hit) hit.count++;
			else hits.set(key, { place, count: 1 });
		}
	}
	// Map keeps insertion order, so equal counts stay in the order found.
	return [...hits.values()]
		.sort((a, b) => b.count - a.count)
		.map((h) => h.place);
}

export async function findPlaces(opts: {
	city: string;
	/** The place as the patient said it, in whatever script. */
	spoken: string;
	lookup: PlaceLookup;
	/** Lookup over all of Tunisia, tried when `lookup` finds nothing. */
	widerLookup?: PlaceLookup;
	apiKey: string | undefined;
	logger: Logger;
}): Promise<PlaceSearchResult[]> {
	const { city, spoken, lookup, widerLookup, apiKey, logger } = opts;
	const startedAt = Date.now();
	const heard = `${spoken}, ${city}`;
	// The text as heard is searched while the small model writes the others.
	const heardLookup = lookup(heard);
	heardLookup.catch(() => {});

	let written: string[] = [];
	if (apiKey && REWRITE) {
		try {
			written = await writeQueries(apiKey, city, spoken);
		} catch (error) {
			logger.warn({ error }, "Location search: writing queries failed");
		}
	}
	const texts = [heard, ...written.filter((q) => q !== heard)];
	const writtenMs = Date.now() - startedAt;

	let candidates = await lookUpAll(texts, lookup, heardLookup);
	if (candidates.length === 0 && widerLookup) {
		logger.info(
			{ city },
			"Location search: no results inside city radius, retrying country-wide",
		);
		candidates = await lookUpAll(texts, widerLookup);
	}
	candidates = candidates.slice(0, MAX_CANDIDATES);
	logger.info(
		{
			spoken,
			city,
			texts,
			candidates: candidates.map((p) => p.label),
			writtenMs,
			searchedMs: Date.now() - startedAt,
		},
		"Location search: candidates",
	);
	if (candidates.length === 0 || !apiKey) {
		return candidates.slice(0, MAX_RESULTS);
	}

	try {
		const picked = await reviewCandidates(apiKey, city, spoken, candidates);
		logger.info(
			{ picked: picked.map((p) => p.label), totalMs: Date.now() - startedAt },
			"Location search: reviewed",
		);
		return picked.slice(0, MAX_RESULTS);
	} catch (error) {
		logger.warn({ error }, "Location search: review failed, keeping all");
		return candidates.slice(0, MAX_RESULTS);
	}
}
