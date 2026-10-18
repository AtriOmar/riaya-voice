import type { Logger } from "pino";
import { getTwilioClient } from "./twilioClient.js";

/**
 * Starts a Twilio recording on a call that is already in progress. Used instead
 * of `<Record>` in the TwiML because the call is bridged with `<Connect><Stream>`
 * (or `<Dial><Sip>`), which cannot be combined with it.
 *
 * When the recording is ready, Twilio calls the web app's recording webhook,
 * which saves the audio to R2 and stores the link on the call row. The webhook
 * checks Twilio's signature against `${NEXT_PUBLIC_APP_URL}/api/calls/recording-webhook`,
 * so `WEB_PUBLIC_URL` here must be the same public address as the web app's
 * `NEXT_PUBLIC_APP_URL`.
 *
 * Does nothing (and says why in the log) when `WEB_PUBLIC_URL` or Twilio is not
 * configured, so a missing setting never affects the call itself.
 */
export async function startCallRecording(
	callSid: string,
	logger: Logger,
): Promise<void> {
	const webUrl = process.env.WEB_PUBLIC_URL?.trim().replace(/\/$/, "");
	if (!webUrl) {
		logger.warn({ callSid }, "⏺️ Recording skipped: WEB_PUBLIC_URL is not set");
		return;
	}
	const client = getTwilioClient();
	if (!client) return;

	try {
		const recording = await client.calls(callSid).recordings.create({
			recordingChannels: "dual",
			recordingStatusCallback: `${webUrl}/api/calls/recording-webhook`,
			recordingStatusCallbackMethod: "POST",
			recordingStatusCallbackEvent: ["completed"],
		});
		logger.info(
			{ callSid, recordingSid: recording.sid },
			"⏺️ Call recording started",
		);
	} catch (err) {
		logger.error({ err, callSid }, "🔥 Failed to start call recording");
	}
}
