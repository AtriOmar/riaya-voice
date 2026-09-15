// ==================== WebSocket Messages ====================

/** Messages sent from the realtime server to the frontend dashboard */
export type DashboardMessage =
	| { type: "call_start"; callSid: string; timestamp: string }
	| { type: "call_end"; callSid: string; timestamp: string }
	| {
			type: "patient_transcript";
			callSid: string;
			text: string;
			isFinal: boolean;
	  }
	| {
			type: "ai_transcript";
			callSid: string;
			text: string;
			delta: string;
			isFinal: boolean;
	  }
	| { type: "patient_audio"; callSid: string; payload: string } // base64 g711_ulaw
	| { type: "ai_audio"; callSid: string; payload: string } // base64 g711_ulaw
	| {
			type: "function_call";
			callSid: string;
			name: string;
			args: string;
			status: "calling" | "success" | "error";
			result?: string;
	  }
	// biome-ignore lint/suspicious/noExplicitAny: ignore
	| { type: "appointment_booked"; callSid: string; data: any }
	| { type: "error"; callSid: string; message: string };

// ==================== Twilio Media Stream ====================

export type TwilioMediaMessage =
	| {
			event: "connected";
			protocol: string;
			version: string;
	  }
	| {
			event: "start";
			sequenceNumber: string;
			start: {
				streamSid: string;
				accountSid: string;
				callSid: string;
				tracks: string[];
				mediaFormat: {
					encoding: string;
					sampleRate: number;
					channels: number;
				};
				customParameters: Record<string, string>;
			};
			streamSid: string;
	  }
	| {
			event: "media";
			sequenceNumber: string;
			media: {
				track: string;
				chunk: string;
				timestamp: string;
				payload: string; // base64 audio
			};
			streamSid: string;
	  }
	| {
			event: "dtmf";
			streamSid: string;
			sequenceNumber: string;
			dtmf: { track: string; digit: string };
	  }
	| {
			event: "stop";
			sequenceNumber: string;
			stop: { accountSid: string; callSid: string };
			streamSid: string;
	  }
	| {
			event: "mark";
			sequenceNumber: string;
			streamSid: string;
			mark: { name: string };
	  };

// ==================== OpenAI Realtime ====================

export type SystemMessageTool = {
	type: "function";
	name: string;
	description: string;
	// biome-ignore lint/suspicious/noExplicitAny: ignore
	parameters: Record<string, any>;
};

export type SystemMessage = {
	type: string;
	initialInstructions: string;
	message: string;
	tools: SystemMessageTool[];
};

export type OpenAIError = {
	type: string;
	code?: string;
	message: string;
	event_id?: string;
};

export type RateLimits = {
	name: string;
	limit: number;
	remaining: number;
	reset_seconds: number;
};

export type FunctionCallResponse = {
	type: "function_call_output";
	call_id: string;
	output: string;
};

// ==================== API Types ====================

/** Row from `GET /api/doctors/best-fit` (see web-ts doctors route) */
export type BestFitDoctor = {
	id: number;
	userId: string;
	firstName: string;
	lastName: string;
	/** Practice / cabinet street address when stored on the profile */
	address: string | null;
	tin: string;
	status: string;
	cabinetName: string;
	cabinetCityId: number;
	cabinetLongitude: number;
	cabinetLatitude: number;
	specialityId: number;
	cinRecto: string | null;
	cinVerso: string | null;
	createdAt: string;
	updatedAt: string;
	distance: number;
	nextSlot: { start: string; end: string };
	/** Additional forward slots near desiredTime for same-call alternatives. */
	nearbySlots?: { start: string; end: string }[];
};

/** Response from `GET /api/doctors/availability` */
export type DoctorAvailabilityResponse = {
	doctor: {
		id: number;
		firstName: string;
		lastName: string;
		cabinetName: string;
		address: string | null;
	};
	found: boolean;
	slots: { start: string; end: string }[];
};

/** Body for `POST /api/appointments/external` */
export type BookAppointmentParams = {
	doctorId: number;
	name: string;
	phoneNumber: string;
	illness: string;
	start: string;
	end: string;
};

export type FindSlotsParams = {
	specialitySlug: string;
	latitude: number;
	longitude: number;
	preferredTime?: string;
};
