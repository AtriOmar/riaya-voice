import { WebSocket } from "ws";

/**
 * The live feed of the admin Live Calls page and of the doctors' calendars.
 * Admins receive every message. A doctor only receives the booking events of
 * their own practice, never a transcript.
 */
export class DashboardHub {
	private readonly admins = new Set<WebSocket>();
	private readonly doctors = new Map<number, Set<WebSocket>>();

	addAdmin(ws: WebSocket): () => void {
		this.admins.add(ws);
		return () => {
			this.admins.delete(ws);
		};
	}

	addDoctor(doctorId: number, ws: WebSocket): () => void {
		const set = this.doctors.get(doctorId) ?? new Set<WebSocket>();
		set.add(ws);
		this.doctors.set(doctorId, set);
		return () => {
			set.delete(ws);
			if (set.size === 0) this.doctors.delete(doctorId);
		};
	}

	/** `message` is a dashboard message object or its JSON text. */
	publish(message: unknown): void {
		const json =
			typeof message === "string" ? message : JSON.stringify(message);
		for (const client of this.admins) {
			if (client.readyState === WebSocket.OPEN) client.send(json);
		}
		if (this.doctors.size === 0) return;
		try {
			const parsed =
				typeof message === "string" ? JSON.parse(message) : message;
			if (parsed?.type !== "appointment_booked") return;
			const doctorId = Number(parsed.data?.doctorId);
			for (const client of this.doctors.get(doctorId) ?? []) {
				if (client.readyState === WebSocket.OPEN) client.send(json);
			}
		} catch {
			/* not JSON: admins only */
		}
	}
}
