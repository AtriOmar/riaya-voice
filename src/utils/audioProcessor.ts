/**
 * Ultra-lightweight Audio Processor for Twilio G.711 μ-law streaming audio.
 * Zero external dependencies.
 *
 * 1. High-Pass IIR Filter: Cuts low-frequency rumble, AC hum, line noise (< 250 Hz).
 * 2. Dynamic Noise Gate: Tracks ambient room noise floor and gates background silence.
 */

// 1. Pre-computed 256-entry μ-law to 16-bit PCM lookup table
const MULAW_TO_PCM = new Int16Array(256);
for (let i = 0; i < 256; i++) {
	const mu = ~i;
	const sign = mu & 0x80;
	const exponent = (mu >> 4) & 0x07;
	const mantissa = mu & 0x0f;
	let sample = ((mantissa << 3) + 132) << exponent;
	sample -= 132;
	MULAW_TO_PCM[i] = sign ? -sample : sample;
}

// 2. 16-bit PCM to μ-law encoder
export function pcmToMulawSample(pcm: number): number {
	const MULAW_MAX = 0x1fff;
	const BIAS = 132;
	const sign = (pcm >> 8) & 0x80;
	if (sign) pcm = -pcm;
	if (pcm > MULAW_MAX) pcm = MULAW_MAX;
	pcm += BIAS;

	let exponent = 7;
	for (
		let expMask = 0x4000;
		(pcm & expMask) === 0 && exponent > 0;
		expMask >>= 1
	) {
		exponent--;
	}

	const mantissa = (pcm >> (exponent + 3)) & 0x0f;
	const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
	return mulaw;
}

export function mulawToPcmSample(mulawByte: number): number {
	return MULAW_TO_PCM[mulawByte & 0xff];
}

const SILENT_MULAW_BYTE = 0xff;

export interface AudioFilterOptions {
	enabled?: boolean;
	highPassCutoffHz?: number;
	noiseGateThreshold?: number;
}

export interface FrameProcessingResult {
	payload: string;
	isGated: boolean;
	originalRms: number;
	filteredRms: number;
}

export class AudioProcessor {
	private enabled: boolean;
	private highPassEnabled: boolean;
	private noiseGateThreshold: number;
	private prevX = 0;
	private prevY = 0;
	private alpha = 0.82;
	private noiseFloor = 100;

	constructor(options: AudioFilterOptions = {}) {
		this.enabled =
			options.enabled ?? process.env.NOISE_SUPPRESSION_ENABLED !== "false";
		this.highPassEnabled = options.highPassCutoffHz !== 0;
		this.noiseGateThreshold =
			options.noiseGateThreshold ??
			parseFloat(process.env.NOISE_GATE_THRESHOLD || "300");

		const cutoff = options.highPassCutoffHz ?? 250;
		const dt = 1 / 8000;
		const rc = 1 / (2 * Math.PI * cutoff);
		this.alpha = rc / (rc + dt);
	}

	/**
	 * Process a base64 μ-law frame (e.g. 160 bytes = 20ms at 8kHz).
	 * Returns processed frame with filtering, noise gating, and RMS stats.
	 */
	public processFrame(base64Payload: string): FrameProcessingResult {
		if (!this.enabled) {
			return {
				payload: base64Payload,
				isGated: false,
				originalRms: 0,
				filteredRms: 0,
			};
		}

		const buffer = Buffer.from(base64Payload, "base64");
		const sampleCount = buffer.length;
		const pcmSamples = new Int16Array(sampleCount);

		let rawSumSq = 0;
		let filteredSumSq = 0;

		// Step 1: Decode μ-law & High-Pass Filter (cut low-freq hum)
		for (let i = 0; i < sampleCount; i++) {
			const rawPcm = MULAW_TO_PCM[buffer[i]];
			rawSumSq += rawPcm * rawPcm;
			let inputSample = rawPcm;

			if (this.highPassEnabled) {
				// 1st Order IIR Highpass: y[n] = alpha * (y[n-1] + x[n] - x[n-1])
				const outputSample =
					this.alpha * (this.prevY + inputSample - this.prevX);
				this.prevX = inputSample;
				this.prevY = outputSample;
				inputSample = Math.max(-32768, Math.min(32767, outputSample));
			}

			pcmSamples[i] = inputSample;
			filteredSumSq += inputSample * inputSample;
		}

		const rawRms = Math.sqrt(rawSumSq / sampleCount);
		const filteredRms = Math.sqrt(filteredSumSq / sampleCount);

		// Step 2: Adaptive Noise Floor tracking
		if (filteredRms < this.noiseFloor) {
			this.noiseFloor = this.noiseFloor * 0.95 + filteredRms * 0.05;
		} else if (filteredRms < this.noiseFloor * 2) {
			this.noiseFloor = this.noiseFloor * 0.99 + filteredRms * 0.01;
		}

		// Step 3: Noise Gate Decision
		const effectiveThreshold = Math.max(
			this.noiseGateThreshold,
			this.noiseFloor * 2.2,
		);
		const isGated = filteredRms < effectiveThreshold;

		if (isGated) {
			const silentBuffer = Buffer.alloc(sampleCount, SILENT_MULAW_BYTE);
			return {
				payload: silentBuffer.toString("base64"),
				isGated: true,
				originalRms: rawRms,
				filteredRms: 0,
			};
		}

		// Step 4: Re-encode filtered PCM to μ-law
		for (let i = 0; i < sampleCount; i++) {
			buffer[i] = pcmToMulawSample(pcmSamples[i]);
		}

		return {
			payload: buffer.toString("base64"),
			isGated: false,
			originalRms: rawRms,
			filteredRms,
		};
	}
}
