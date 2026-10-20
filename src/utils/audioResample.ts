import { mulawToPcmSample } from "./audioProcessor.js";

/**
 * Twilio μ-law 8 kHz ⇄ PCM16 (little-endian) converters for providers that
 * don't speak G.711 natively (Gemini Live: 16 kHz in, 24 kHz out).
 */

const MULAW_CLIP = 32635;
const MULAW_BIAS = 0x84;

/** Standard G.711 μ-law encoder over the full 16-bit range. */
function encodeMulaw(sample: number): number {
	let pcm = sample;
	const sign = pcm < 0 ? 0x80 : 0;
	if (sign) pcm = -pcm;
	if (pcm > MULAW_CLIP) pcm = MULAW_CLIP;
	pcm += MULAW_BIAS;
	let exponent = 7;
	for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) {
		exponent--;
	}
	const mantissa = (pcm >> (exponent + 3)) & 0x0f;
	return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** μ-law 8 kHz (base64) → PCM16 16 kHz (base64), linear interpolation. */
export function mulaw8kToPcm16k(mulawBase64: string): string {
	const mulaw = Buffer.from(mulawBase64, "base64");
	const out = Buffer.alloc(mulaw.length * 4);
	for (let i = 0; i < mulaw.length; i++) {
		const cur = mulawToPcmSample(mulaw[i]);
		const next = i + 1 < mulaw.length ? mulawToPcmSample(mulaw[i + 1]) : cur;
		out.writeInt16LE(cur, i * 4);
		out.writeInt16LE((cur + next) >> 1, i * 4 + 2);
	}
	return out.toString("base64");
}

/**
 * PCM16 24 kHz → μ-law 8 kHz. Stateful: carries leftover bytes/samples between
 * chunks so odd-sized chunks don't introduce clicks. Averages each group of 3
 * samples (cheap low-pass) before decimating.
 */
export class Pcm24kToMulaw8k {
	private pendingByte: number | null = null;
	private pendingSamples: number[] = [];

	convert(pcmBase64: string): string {
		let bytes = Buffer.from(pcmBase64, "base64");
		if (this.pendingByte !== null) {
			bytes = Buffer.concat([Buffer.from([this.pendingByte]), bytes]);
			this.pendingByte = null;
		}
		if (bytes.length % 2 === 1) {
			this.pendingByte = bytes[bytes.length - 1];
			bytes = bytes.subarray(0, bytes.length - 1);
		}

		const samples = this.pendingSamples;
		for (let i = 0; i < bytes.length; i += 2)
			samples.push(bytes.readInt16LE(i));

		const outLen = Math.floor(samples.length / 3);
		const out = Buffer.alloc(outLen);
		for (let o = 0; o < outLen; o++) {
			const s = o * 3;
			const avg = Math.round(
				(samples[s] + samples[s + 1] + samples[s + 2]) / 3,
			);
			out[o] = encodeMulaw(avg);
		}
		this.pendingSamples = samples.slice(outLen * 3);
		return out.toString("base64");
	}

	reset() {
		this.pendingByte = null;
		this.pendingSamples = [];
	}
}
