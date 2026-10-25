// The assistant reads and writes Tunisia wall-clock times; the web API works in
// UTC instants. Converting here keeps time-zone arithmetic out of the model.

const TIME_ZONE = "Africa/Tunis";

/** Minutes Tunisia is ahead of UTC at `date`. */
function offsetMinutes(date: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: TIME_ZONE,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(date);
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return Math.round((asUtc - date.getTime()) / 60_000);
}

/** The instant as Tunisia local time, `YYYY-MM-DDTHH:mm`. */
export function toTunisLocal(instant: string | Date): string {
	const date = new Date(instant);
	const local = new Date(date.getTime() + offsetMinutes(date) * 60_000);
	return local.toISOString().slice(0, 16);
}

/** The instant in words, e.g. "Monday 26 October, 10:30" (Tunisia time). */
export function tunisLabel(instant: string | Date): string {
	const date = new Date(instant);
	const day = new Intl.DateTimeFormat("en-GB", {
		timeZone: TIME_ZONE,
		weekday: "long",
		day: "numeric",
		month: "long",
	}).format(date);
	return `${day}, ${toTunisLocal(date).slice(11)}`;
}

const LOCAL =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const WITH_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A time from the model as a UTC ISO string for the web API. Tunisia local
 * `YYYY-MM-DDTHH:mm` is the expected form; a time that already names its zone
 * (`Z` or an offset) is taken as is. Null when it cannot be read.
 */
export function fromTunisLocal(value: string): string | null {
	const text = value.trim();
	if (WITH_ZONE.test(text)) {
		const date = new Date(text);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	const m = LOCAL.exec(text);
	if (!m) return null;
	const [, y, mo, d, h, mi] = m.map(Number);
	const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
	return new Date(
		guess.getTime() - offsetMinutes(guess) * 60_000,
	).toISOString();
}

/** A slot from the web API, as the assistant gets it. */
export function localSlot(slot: { start: string; end: string }) {
	return {
		slotStart: toTunisLocal(slot.start),
		slotEnd: toTunisLocal(slot.end),
		when: tunisLabel(slot.start),
	};
}
