import type { Logger } from "pino";
import { mulawToPcmSample } from "../utils/audioProcessor.js";

/**
 * Ends calls nobody is talking on, and caps how long any call can run.
 * Shared by every call path: the path feeds it "caller spoke", "assistant
 * speaking" and "tool running" signals and acts on its callbacks.
 *
 * Silence: once the assistant is quiet, wait `promptMs` for the caller. Then
 * ask once whether they are still there, and if they stay silent for
 * `hangupMs` after that question, say goodbye and hang up. Any caller speech
 * starts over.
 *
 * Time limit: at `MAX_CALL_MS` the assistant says goodbye and the call ends.
 */

function envMs(name: string, fallback: number): number {
	const n = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SILENCE_PROMPT_MS = envMs("SILENCE_PROMPT_MS", 12_000);
export const SILENCE_HANGUP_MS = envMs("SILENCE_HANGUP_MS", 10_000);
export const MAX_CALL_MS = envMs("MAX_CALL_MS", 15 * 60_000);
/** If the "still there?" question never plays, hang up anyway after this. */
const PROMPT_PLAYBACK_GRACE_MS = 8_000;

export type CallWatchdogHandlers = {
	/** Ask the caller, once, whether they are still on the line. */
	onAskStillThere(): void;
	/** The caller stayed silent after the question: say goodbye and hang up. */
	onSilentGoodbye(): void;
	/** The time limit is reached: say goodbye and hang up. */
	onTimeLimit(): void;
};

export class CallWatchdog {
	private askedStillThere = false;
	private assistantSpeaking = false;
	private toolsRunning = 0;
	private stopped = false;
	private started = false;
	private silenceTimer: ReturnType<typeof setTimeout> | null = null;
	private limitTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly logger: Logger,
		private readonly handlers: CallWatchdogHandlers,
	) {}

	/** The call is live (the greeting was sent). Starts the time limit. */
	start() {
		if (this.started || this.stopped) return;
		this.started = true;
		this.limitTimer = setTimeout(() => {
			this.logger.info("⏱️ Call time limit reached");
			this.stop();
			this.handlers.onTimeLimit();
		}, MAX_CALL_MS);
		this.armSilence();
	}

	/** The caller said something: the silence count starts over. */
	callerSpoke() {
		if (this.stopped) return;
		this.askedStillThere = false;
		this.armSilence();
	}

	setAssistantSpeaking(speaking: boolean) {
		if (this.stopped || this.assistantSpeaking === speaking) return;
		this.assistantSpeaking = speaking;
		this.armSilence();
	}

	toolStarted() {
		this.toolsRunning++;
		this.armSilence();
	}

	toolFinished() {
		this.toolsRunning = Math.max(0, this.toolsRunning - 1);
		this.armSilence();
	}

	/** The call is ending some other way (end_call, report_abuse, hangup). */
	stop() {
		this.stopped = true;
		this.clearSilence();
		if (this.limitTimer) clearTimeout(this.limitTimer);
		this.limitTimer = null;
	}

	private clearSilence() {
		if (this.silenceTimer) clearTimeout(this.silenceTimer);
		this.silenceTimer = null;
	}

	/** Restart the silence timer for the current step, or pause it while the assistant is busy. */
	private armSilence() {
		this.clearSilence();
		if (!this.started || this.stopped) return;
		if (this.assistantSpeaking || this.toolsRunning > 0) return;

		if (!this.askedStillThere) {
			this.silenceTimer = setTimeout(() => {
				this.logger.info("🤫 Caller silent, asking if they are still there");
				this.askedStillThere = true;
				this.handlers.onAskStillThere();
				// Normally replaced once the question has played (setAssistantSpeaking).
				this.silenceTimer = setTimeout(
					() => this.giveUp(),
					SILENCE_HANGUP_MS + PROMPT_PLAYBACK_GRACE_MS,
				);
			}, SILENCE_PROMPT_MS);
			return;
		}
		this.silenceTimer = setTimeout(() => this.giveUp(), SILENCE_HANGUP_MS);
	}

	private giveUp() {
		if (this.stopped) return;
		this.logger.info("📴 Caller stayed silent, ending the call");
		this.stop();
		this.handlers.onSilentGoodbye();
	}
}

/**
 * Tells caller speech from line noise on raw μ-law frames, for call paths
 * whose model does not report when the caller starts talking. Needs a short
 * run of loud frames, so clicks and pops do not count.
 */
export class CallerVoiceDetector {
	private noise = 0.003;
	private loudMs = 0;

	constructor(
		private readonly onVoice: () => void,
		private readonly minVoiceMs = 200,
		private readonly minThreshold = 0.012,
	) {}

	/** One base64 μ-law frame of caller audio (Twilio sends 20 ms). */
	push(mulawBase64: string) {
		const bytes = Buffer.from(mulawBase64, "base64");
		if (bytes.length === 0) return;
		let sum = 0;
		for (const b of bytes) {
			const s = mulawToPcmSample(b);
			sum += s * s;
		}
		const rms = Math.sqrt(sum / bytes.length) / 32768;
		const ms = bytes.length / 8;
		if (rms > Math.max(this.minThreshold, this.noise * 3)) {
			this.loudMs += ms;
			if (this.loudMs >= this.minVoiceMs) {
				this.loudMs = 0;
				this.onVoice();
			}
			return;
		}
		this.noise = this.noise * 0.95 + rms * 0.05;
		this.loudMs = 0;
	}
}
