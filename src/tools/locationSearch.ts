/**
 * Finding the patient's area from what they said.
 *
 * One spelling of a place rarely matches the map data: "hay el ons" finds
 * nothing useful, while the data names it "Cité El Ons" or "حي الأنس". So the
 * conversation model sends several spellings of the place in one call, in
 * Arabic and in French, and they are searched in parallel. The geocoder also
 * returns places that only look alike ("Hay Es Salem"), so a result is kept
 * only if its name shares a real word with one of the spellings. Since the
 * spellings cover both scripts, this works without transliteration. The model
 * then names the likely ones, the places found by the most spellings first.
 */

import type { Logger } from "pino";
import { CITIES } from "../constants/cities.js";

const MAX_RESULTS = 8;

/** Words that say what kind of place it is, not which one; sharing only these means nothing. */
const GENERIC_WORDS = [
	"حي نهج شارع طريق ساحة زنقة مستشفى سبيطار مصحة عيادة جامع مدرسة معهد قرب قريب بجنب حذا في",
	"cite hay rue avenue av boulevard route place impasse hopital hospital clinique mosquee ecole lycee college street",
	"pres near cote el al la le les de du des d l",
	"tunisia tunisie",
];

/** Lower-case words, with accents, Arabic vowel marks, tatweel, hamza forms and the article ال evened out. */
function words(text: string): string[] {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f\u064B-\u0652\u0640]/g, "")
		.toLowerCase()
		.replace(/[أإآ]/g, "ا")
		.replace(/ة/g, "ه")
		.replace(/ى/g, "ي")
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
		.map((w) => (w.startsWith("ال") && w.length > 3 ? w.slice(2) : w));
}

const IGNORED_WORDS = new Set(
	[
		...GENERIC_WORDS,
		...CITIES.flatMap((c) => [c.en_name, c.fr_name, c.ar_name]),
	].flatMap(words),
);

/** The words that name a place: no generic words, city names or bare numbers. */
function nameWords(text: string): string[] {
	return words(text).filter(
		(w) => w.length > 1 && !/^\d+$/.test(w) && !IGNORED_WORDS.has(w),
	);
}

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

/** A merged result, with how many of the search texts found it. */
export type FoundPlace = PlaceSearchResult & { foundBy: number };

/**
 * Every distinct place the texts returned, the ones more texts agree on first.
 * Throws when every lookup failed, so an API outage is not taken for "no match".
 */
async function lookUpAll(
	texts: string[],
	lookup: PlaceLookup,
): Promise<FoundPlace[]> {
	const settled = await Promise.allSettled(texts.map((t) => lookup(t)));
	const failed = settled.filter((s) => s.status === "rejected");
	if (failed.length === settled.length) throw failed[0].reason;

	const hits = new Map<string, FoundPlace>();
	for (const s of settled) {
		if (s.status !== "fulfilled") continue;
		for (const place of s.value) {
			if (place.lat === null || place.lng === null) continue;
			const key = place.id || `${place.lat},${place.lng}`;
			const hit = hits.get(key);
			if (hit) hit.foundBy++;
			else hits.set(key, { ...place, foundBy: 1 });
		}
	}
	// Map keeps insertion order, so equal counts stay in the order found.
	return [...hits.values()].sort((a, b) => b.foundBy - a.foundBy);
}

export async function findPlaces(opts: {
	texts: string[];
	lookup: PlaceLookup;
	/** Lookup over all of Tunisia, tried when `lookup` finds nothing. */
	widerLookup?: PlaceLookup;
	logger: Logger;
}): Promise<FoundPlace[]> {
	const { texts, lookup, widerLookup, logger } = opts;
	const asked = new Set(texts.flatMap(nameWords));
	const named = (places: FoundPlace[]) =>
		asked.size === 0
			? places
			: places.filter((p) => nameWords(p.label).some((w) => asked.has(w)));

	let found = await lookUpAll(texts, lookup);
	let places = named(found);
	if (places.length === 0 && widerLookup) {
		logger.info(
			"Location search: no match inside city radius, retrying country-wide",
		);
		found = await lookUpAll(texts, widerLookup);
		places = named(found);
	}
	places = places.slice(0, MAX_RESULTS);
	logger.info(
		{
			texts,
			places: places.map((p) => `${p.label} (${p.foundBy})`),
			dropped: found.length - places.length,
		},
		"Location search",
	);
	return places;
}
