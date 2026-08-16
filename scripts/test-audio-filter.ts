import fs from "fs";
import path from "path";
import { AudioProcessor, mulawToPcmSample, pcmToMulawSample } from "../src/utils/audioProcessor.js";

/**
 * CLI script to test audio noise reduction on WAV audio files or generated synthetic test audio.
 * Usage: pnpm exec tsx scripts/test-audio-filter.ts [path/to/noisy_audio.wav] [output.wav]
 */

function createWavHeader(sampleRate: number, numChannels: number, bitsPerSample: number, dataLength: number): Buffer {
	const header = Buffer.alloc(44);
	const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
	const blockAlign = (numChannels * bitsPerSample) / 8;

	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataLength, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // Subchunk1Size
	header.writeUInt16LE(1, 20); // AudioFormat (PCM = 1)
	header.writeUInt16LE(numChannels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataLength, 40);

	return header;
}

function generateSyntheticNoisyAudio(): { pcmSamples: Int16Array; sampleRate: number } {
	console.log("💡 No audio file specified. Generating 4 seconds of synthetic test audio (speech + AC hum + background hiss)...");
	const sampleRate = 8000;
	const totalSamples = sampleRate * 4; // 4 seconds
	const pcmSamples = new Int16Array(totalSamples);

	for (let i = 0; i < totalSamples; i++) {
		const t = i / sampleRate;

		// 1. Low-frequency AC hum (60 Hz + 120 Hz rumble)
		const acHum = Math.sin(2 * Math.PI * 60 * t) * 800 + Math.sin(2 * Math.PI * 120 * t) * 400;

		// 2. High-frequency static / hiss
		const hiss = (Math.random() - 0.5) * 300;

		// 3. Simulated speech (from 1.0s to 3.0s)
		let speech = 0;
		if (t >= 1.0 && t <= 3.0) {
			// Fundamental frequency 220Hz (A3 voice) + formants
			const vowelF1 = Math.sin(2 * Math.PI * 220 * t) * 4000;
			const vowelF2 = Math.sin(2 * Math.PI * 880 * t) * 2000;
			const envelope = Math.sin(Math.PI * ((t - 1.0) / 2.0)); // smooth envelope
			speech = (vowelF1 + vowelF2) * envelope;
		}

		const total = speech + acHum + hiss;
		pcmSamples[i] = Math.max(-32768, Math.min(32767, Math.round(total)));
	}

	return { pcmSamples, sampleRate };
}

function parseWavFile(filePath: string): { pcmSamples: Int16Array; sampleRate: number } {
	const buffer = fs.readFileSync(filePath);
	if (buffer.toString("utf8", 0, 4) !== "RIFF" || buffer.toString("utf8", 8, 12) !== "WAVE") {
		throw new Error("File is not a valid RIFF/WAVE audio file.");
	}

	let fmtOffset = 12;
	while (fmtOffset < buffer.length) {
		const chunkId = buffer.toString("utf8", fmtOffset, fmtOffset + 4);
		const chunkSize = buffer.readUInt32LE(fmtOffset + 4);
		if (chunkId === "fmt ") break;
		fmtOffset += 8 + chunkSize;
	}

	const audioFormat = buffer.readUInt16LE(fmtOffset + 8);
	const numChannels = buffer.readUInt16LE(fmtOffset + 10);
	const sampleRate = buffer.readUInt32LE(fmtOffset + 12);
	const bitsPerSample = buffer.readUInt16LE(fmtOffset + 22);

	let dataOffset = fmtOffset;
	while (dataOffset < buffer.length) {
		const chunkId = buffer.toString("utf8", dataOffset, dataOffset + 4);
		const chunkSize = buffer.readUInt32LE(dataOffset + 4);
		if (chunkId === "data") {
			dataOffset += 8;
			break;
		}
		dataOffset += 8 + chunkSize;
	}

	const dataBuffer = buffer.subarray(dataOffset);
	const totalSamples = Math.floor(dataBuffer.length / (bitsPerSample / 8) / numChannels);
	const pcmSamples = new Int16Array(totalSamples);

	for (let i = 0; i < totalSamples; i++) {
		if (audioFormat === 7) {
			// μ-law format
			pcmSamples[i] = mulawToPcmSample(dataBuffer[i * numChannels]);
		} else if (bitsPerSample === 16) {
			pcmSamples[i] = dataBuffer.readInt16LE(i * numChannels * 2);
		} else if (bitsPerSample === 8) {
			pcmSamples[i] = (dataBuffer[i * numChannels] - 128) * 256;
		}
	}

	return { pcmSamples, sampleRate };
}

function runFilterTest() {
	const args = process.argv.slice(2);
	const inputPath = args[0];
	let outputPath = args[1];

	let inputPcm: Int16Array;
	let sampleRate: number;

	if (inputPath && fs.existsSync(inputPath)) {
		console.log(`📁 Reading audio file: ${inputPath}`);
		const parsed = parseWavFile(inputPath);
		inputPcm = parsed.pcmSamples;
		sampleRate = parsed.sampleRate;
		if (!outputPath) {
			const ext = path.extname(inputPath);
			outputPath = path.join(path.dirname(inputPath), `${path.basename(inputPath, ext)}_filtered.wav`);
		}
	} else {
		const synthetic = generateSyntheticNoisyAudio();
		inputPcm = synthetic.pcmSamples;
		sampleRate = synthetic.sampleRate;
		outputPath = outputPath || path.join(process.cwd(), "test_filtered_output.wav");
	}

	const processor = new AudioProcessor({
		enabled: true,
		highPassCutoffHz: 250,
		noiseGateThreshold: 300,
	});

	// Frame size for 20ms at 8000Hz is 160 samples
	const FRAME_SIZE = Math.floor((sampleRate * 20) / 1000);
	const totalFrames = Math.floor(inputPcm.length / FRAME_SIZE);

	console.log(`\n🎧 Processing Audio:`);
	console.log(`   Sample Rate : ${sampleRate} Hz`);
	console.log(`   Duration    : ${(inputPcm.length / sampleRate).toFixed(2)} seconds`);
	console.log(`   Frame Count : ${totalFrames} frames (20ms each)`);

	const outputPcm = new Int16Array(inputPcm.length);
	let gatedFramesCount = 0;
	let activeFramesCount = 0;
	const startTime = performance.now();

	for (let f = 0; f < totalFrames; f++) {
		const frameStart = f * FRAME_SIZE;
		const frameEnd = frameStart + FRAME_SIZE;
		const frameMulawBuffer = Buffer.alloc(FRAME_SIZE);

		for (let i = 0; i < FRAME_SIZE; i++) {
			frameMulawBuffer[i] = pcmToMulawSample(inputPcm[frameStart + i]);
		}

		const base64Input = frameMulawBuffer.toString("base64");
		const result = processor.processFrame(base64Input);
		const filteredMulawBuffer = Buffer.from(result.payload, "base64");

		if (result.isGated) {
			gatedFramesCount++;
		} else {
			activeFramesCount++;
		}

		for (let i = 0; i < FRAME_SIZE; i++) {
			outputPcm[frameStart + i] = mulawToPcmSample(filteredMulawBuffer[i]);
		}
	}

	const elapsedTime = performance.now() - startTime;

	// Write output WAV file (16-bit PCM)
	const pcmDataBuffer = Buffer.alloc(outputPcm.length * 2);
	for (let i = 0; i < outputPcm.length; i++) {
		pcmDataBuffer.writeInt16LE(outputPcm[i], i * 2);
	}

	const wavHeader = createWavHeader(sampleRate, 1, 16, pcmDataBuffer.length);
	fs.writeFileSync(outputPath, Buffer.concat([wavHeader, pcmDataBuffer]));

	console.log(`\n✅ Filter Test Finished in ${elapsedTime.toFixed(2)} ms!`);
	console.log(`--------------------------------------------------`);
	console.log(`📊 Statistics Summary:`);
	console.log(`   • Total 20ms Frames Processed : ${totalFrames}`);
	console.log(`   • Silent/Noise Muted Frames    : ${gatedFramesCount} (${((gatedFramesCount / totalFrames) * 100).toFixed(1)}%)`);
	console.log(`   • Speech Passed Frames         : ${activeFramesCount} (${((activeFramesCount / totalFrames) * 100).toFixed(1)}%)`);
	console.log(`   • Processing Speed             : ${(elapsedTime / totalFrames).toFixed(4)} ms per 20ms frame`);
	console.log(`   • CPU Core Load                : ${((elapsedTime / ((inputPcm.length / sampleRate) * 1000)) * 100).toFixed(3)}% of 1 CPU core`);
	console.log(`--------------------------------------------------`);
	console.log(`🔊 Filtered WAV file written to: ${outputPath}`);
}

runFilterTest();
