/**
 * Voice activity detection by loudness, for `infer meeting`.
 *
 * Whisper, fed a stretch without speech, writes the stock phrase of the
 * subtitles it was trained on — "Merci.", "Thank you." — so silence is cut
 * out before upload: only speech reaches it, and its timestamps are mapped
 * back to the meeting's clock afterwards.
 *
 * The threshold adapts to each track: a quiet room and a noisy one differ by
 * tens of decibels, so speech is what stands clearly above the track's own
 * noise floor, not above a fixed level.
 */

export const SAMPLE_RATE = 16_000;
/** 30 ms frames: short enough to find word edges, long enough to be stable. */
const FRAME = 480;
const FRAME_SECONDS = FRAME / SAMPLE_RATE;

/** How far above the noise floor counts as speech. */
const ABOVE_FLOOR_DB = 12;
/** Never call anything quieter than this speech, however silent the room. */
const MIN_THRESHOLD_DB = -55;
/** Pauses shorter than this stay inside one region: breaths, between words. */
const BRIDGE_SECONDS = 0.6;
/** Blips shorter than this are clicks and bumps, not speech. */
const MIN_SPEECH_SECONDS = 0.25;
/** Kept either side of a region, so the first and last syllables survive. */
const PAD_SECONDS = 0.3;
/** Silence put between spliced regions, so words do not run together. */
const GAP_SECONDS = 0.3;

export interface Region {
	readonly start: number;
	readonly end: number;
}

/** RMS level of each 30 ms frame, in dBFS, floored at -100. */
export const frameLevels = (samples: Int16Array): Float32Array => {
	const count = Math.floor(samples.length / FRAME);
	const levels = new Float32Array(count);
	for (let frame = 0; frame < count; frame++) {
		let sum = 0;
		const offset = frame * FRAME;
		for (let i = 0; i < FRAME; i++) {
			const sample = (samples[offset + i] ?? 0) / 32768;
			sum += sample * sample;
		}
		const rms = Math.sqrt(sum / FRAME);
		levels[frame] = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
	}
	return levels;
};

/** The level a track sits at when nobody speaks: its 10th percentile. */
const noiseFloor = (levels: Float32Array): number => {
	const sorted = Float32Array.from(levels).sort();
	return sorted[Math.floor(sorted.length * 0.1)] ?? -100;
};

/** Where a track has speech, in seconds, padded and with short pauses bridged. */
export const speechRegions = (
	levels: Float32Array,
	duration = levels.length * FRAME_SECONDS,
): ReadonlyArray<Region> => {
	if (levels.length === 0) return [];
	const threshold = Math.max(
		noiseFloor(levels) + ABOVE_FLOOR_DB,
		MIN_THRESHOLD_DB,
	);
	const raw: Array<Region> = [];
	let open: number | undefined;
	for (let frame = 0; frame <= levels.length; frame++) {
		const loud = frame < levels.length && (levels[frame] ?? -100) > threshold;
		if (loud && open === undefined) open = frame;
		if (!loud && open !== undefined) {
			raw.push({ start: open * FRAME_SECONDS, end: frame * FRAME_SECONDS });
			open = undefined;
		}
	}
	const bridged: Array<Region> = [];
	for (const region of raw) {
		const last = bridged.at(-1);
		if (last && region.start - last.end < BRIDGE_SECONDS) {
			bridged[bridged.length - 1] = { start: last.start, end: region.end };
		} else bridged.push(region);
	}
	const padded: Array<Region> = [];
	for (const region of bridged) {
		if (region.end - region.start < MIN_SPEECH_SECONDS) continue;
		const start = Math.max(0, region.start - PAD_SECONDS);
		const end = Math.min(duration, region.end + PAD_SECONDS);
		const last = padded.at(-1);
		if (last && start <= last.end) {
			padded[padded.length - 1] = { start: last.start, end };
		} else padded.push({ start, end });
	}
	return padded;
};

/** Where a spliced region sits in the cut audio and in the original. */
export interface Splice {
	readonly cut: number;
	readonly original: number;
	readonly length: number;
}

/**
 * The regions joined into one shorter track, a short silence between each,
 * and the map from the cut audio's clock back to the original's.
 */
export const splice = (
	samples: Int16Array,
	regions: ReadonlyArray<Region>,
): { readonly audio: Int16Array; readonly map: ReadonlyArray<Splice> } => {
	const gap = Math.round(GAP_SECONDS * SAMPLE_RATE);
	const spans = regions.map((region) => ({
		from: Math.round(region.start * SAMPLE_RATE),
		to: Math.min(samples.length, Math.round(region.end * SAMPLE_RATE)),
	}));
	const total = spans.reduce(
		(sum, span, index) => sum + (span.to - span.from) + (index > 0 ? gap : 0),
		0,
	);
	const audio = new Int16Array(total);
	const map: Array<Splice> = [];
	let at = 0;
	for (const [index, span] of spans.entries()) {
		if (index > 0) at += gap;
		audio.set(samples.subarray(span.from, span.to), at);
		map.push({
			cut: at / SAMPLE_RATE,
			original: span.from / SAMPLE_RATE,
			length: (span.to - span.from) / SAMPLE_RATE,
		});
		at += span.to - span.from;
	}
	return { audio, map };
};

/**
 * A time in the cut audio, back on the original's clock. A time in a gap
 * between regions belongs to the region before it.
 */
export const toOriginal = (
	time: number,
	map: ReadonlyArray<Splice>,
): number => {
	let low = 0;
	let high = map.length - 1;
	let found = 0;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if ((map[middle]?.cut ?? 0) <= time) {
			found = middle;
			low = middle + 1;
		} else high = middle - 1;
	}
	const piece = map[found];
	if (piece === undefined) return time;
	return piece.original + Math.min(time - piece.cut, piece.length);
};
