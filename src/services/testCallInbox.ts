import type { RawData, WebSocket } from "ws";

/**
 * Test-call pages register here (by phone number) so outbound callbacks can
 * ring the page instead of going out through Twilio.
 */
const inboxes = new Map<string, Set<WebSocket>>();

/** How long a callback rings before it counts as unanswered. */
const RING_TIMEOUT_MS = 30_000;

/** Compare phones by digits only so "+216 12 345 678" matches "21612345678". */
export function inboxKey(phone: string): string {
	return phone.replace(/\D/g, "");
}

export function registerTestCallInbox(
	phone: string,
	ws: WebSocket,
): () => void {
	const key = inboxKey(phone);
	if (!key) return () => {};
	let set = inboxes.get(key);
	if (!set) {
		set = new Set();
		inboxes.set(key, set);
	}
	set.add(ws);
	return () => {
		set.delete(ws);
		if (set.size === 0) inboxes.delete(key);
	};
}

export type IncomingTestCall = {
	reason: "refused" | "timeout";
};

export type TestCallOutcome = "answered" | "declined" | "no-answer";

/**
 * Rings every open test-call page for `phone` and waits for the first reply.
 * Resolves `null` immediately when no page is listening, so the caller can fall
 * back to Twilio. A silent page resolves `"no-answer"` after the ring timeout.
 */
export function ringTestCallInbox(
	phone: string,
	call: IncomingTestCall,
): Promise<TestCallOutcome | null> {
	const set = inboxes.get(inboxKey(phone));
	const targets = set ? [...set].filter((ws) => ws.readyState === ws.OPEN) : [];
	if (targets.length === 0) return Promise.resolve(null);

	const ring = JSON.stringify({ type: "incoming_call", ...call });
	const stop = JSON.stringify({ type: "call_ended" });

	return new Promise((resolve) => {
		const finish = (outcome: TestCallOutcome) => {
			clearTimeout(timer);
			for (const ws of targets) {
				ws.off("message", onMessage);
				ws.off("close", onClose);
				if (ws.readyState === ws.OPEN) ws.send(stop);
			}
			resolve(outcome);
		};
		const onMessage = (data: RawData) => {
			try {
				const msg = JSON.parse(data.toString()) as { type?: string };
				if (msg.type === "answered" || msg.type === "declined") {
					finish(msg.type);
				}
			} catch {
				// ignore malformed frames
			}
		};
		const onClose = () => {
			if (targets.every((ws) => ws.readyState !== ws.OPEN)) {
				finish("no-answer");
			}
		};
		const timer = setTimeout(() => finish("no-answer"), RING_TIMEOUT_MS);

		for (const ws of targets) {
			ws.on("message", onMessage);
			ws.on("close", onClose);
			ws.send(ring);
		}
	});
}
