/**
 * A ZIP archive written as a stream, for `infer human download`'s Download
 * all.
 *
 * Every entry is stored, not deflated: the files worth handing over are mostly
 * media, already compressed, and storing them means the archive's exact size
 * is known before the first byte — so the browser shows real progress — and
 * nothing but the chunk in flight is ever held in memory. Each entry's CRC is
 * computed as it streams and written after it, in a data descriptor. ZIP64
 * fields appear only where a size or an offset passes 4 GB, so ordinary
 * archives stay readable by every unzip there is.
 *
 * Written beside the page server and imported by it, like `ui-upload.ts`, so
 * it may import nothing but Node built-ins. See `docs/adrs/0034`.
 */

import { crc32 } from "node:zlib";

/** One file to put in the archive. */
export interface ZipEntry {
	/** The name inside the archive, already unique. */
	readonly name: string;
	readonly size: number;
	readonly modified: Date;
	/** The entry's bytes, exactly `size` of them. */
	readonly open: () => AsyncIterable<Uint8Array>;
}

export interface ZipOptions {
	/** `always` writes ZIP64 fields for every entry; for tests. */
	readonly zip64?: "auto" | "always";
}

interface Planned {
	readonly entry: ZipEntry;
	readonly name: Uint8Array;
	readonly offset: number;
	readonly zip64: boolean;
}

/** The archive laid out before it is written, so its size is known up front. */
export interface ZipPlan {
	readonly entries: ReadonlyArray<Planned>;
	readonly centralOffset: number;
	readonly centralSize: number;
	readonly zip64End: boolean;
	/** The archive's exact length in bytes. */
	readonly size: number;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** General purpose flags: sizes in a data descriptor (3), UTF-8 names (11). */
const FLAGS = 0x0808;
/** Made by Unix (3), spec version 4.5, so the mode below is honoured. */
const MADE_BY = (3 << 8) | 45;
/** A regular file, rw-r--r--, in the high half of the external attributes. */
const FILE_MODE = (0o100644 << 16) >>> 0;

const LOCAL = 30;
const CENTRAL = 46;
const ZIP64_LOCAL_EXTRA = 4 + 16;
const ZIP64_CENTRAL_EXTRA = 4 + 24;
const ZIP64_END = 56;
const ZIP64_LOCATOR = 20;
const END = 22;

const descriptorSize = (zip64: boolean): number => (zip64 ? 24 : 16);

/**
 * Names unique inside one archive, `a.txt` then `a (2).txt`. Compared without
 * case, since unzipping onto macOS or Windows would merge `A.txt` and `a.txt`.
 */
export const zipNames = (
	names: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const taken = new Set<string>();
	return names.map((raw) => {
		// A name is one path segment; an archive must not create folders or
		// climb out of the one it is unzipped into.
		const base =
			raw
				.split(/[/\\]/)
				.pop()
				// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
				?.replace(/[\u0000-\u001f\u007f]/g, "_")
				.replace(/^\.+$/, "") || "file";
		const dot = base.lastIndexOf(".");
		const [stem, ext] =
			dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
		let name = base;
		for (let n = 2; taken.has(name.toLowerCase()); n++) {
			name = `${stem} (${n})${ext}`;
		}
		taken.add(name.toLowerCase());
		return name;
	});
};

/** Lays the archive out: every offset and the total size, before writing. */
export const planZip = (
	entries: ReadonlyArray<ZipEntry>,
	options: ZipOptions = {},
): ZipPlan => {
	const encoder = new TextEncoder();
	const always = options.zip64 === "always";
	const planned: Planned[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const zip64 = always || entry.size >= MAX32 || offset >= MAX32;
		planned.push({ entry, name, offset, zip64 });
		offset +=
			LOCAL +
			name.length +
			(zip64 ? ZIP64_LOCAL_EXTRA : 0) +
			entry.size +
			descriptorSize(zip64);
	}
	const centralOffset = offset;
	const centralSize = planned.reduce(
		(sum, item) =>
			sum + CENTRAL + item.name.length + (item.zip64 ? ZIP64_CENTRAL_EXTRA : 0),
		0,
	);
	const zip64End =
		always ||
		planned.length >= MAX16 ||
		centralOffset >= MAX32 ||
		centralSize >= MAX32;
	return {
		entries: planned,
		centralOffset,
		centralSize,
		zip64End,
		size:
			centralOffset +
			centralSize +
			(zip64End ? ZIP64_END + ZIP64_LOCATOR : 0) +
			END,
	};
};

/** MS-DOS date and time, in local time as unzip reads them back. */
export const dosDateTime = (date: Date): { date: number; time: number } => {
	if (date.getFullYear() < 1980) return { date: (1 << 5) | 1, time: 0 };
	return {
		date:
			((Math.min(date.getFullYear(), 2107) - 1980) << 9) |
			((date.getMonth() + 1) << 5) |
			date.getDate(),
		time:
			(date.getHours() << 11) |
			(date.getMinutes() << 5) |
			Math.floor(date.getSeconds() / 2),
	};
};

/** A little-endian record builder. */
const record = (size: number) => {
	const bytes = new Uint8Array(size);
	const view = new DataView(bytes.buffer);
	let at = 0;
	const writer = {
		u16: (value: number) => {
			view.setUint16(at, value, true);
			at += 2;
			return writer;
		},
		u32: (value: number) => {
			view.setUint32(at, value >>> 0, true);
			at += 4;
			return writer;
		},
		u64: (value: number) => {
			view.setBigUint64(at, BigInt(value), true);
			at += 8;
			return writer;
		},
		bytes: (value: Uint8Array) => {
			bytes.set(value, at);
			at += value.length;
			return writer;
		},
		done: () => bytes,
	};
	return writer;
};

const localHeader = (item: Planned): Uint8Array => {
	const { date, time } = dosDateTime(item.entry.modified);
	const header = record(
		LOCAL + item.name.length + (item.zip64 ? ZIP64_LOCAL_EXTRA : 0),
	)
		.u32(0x04034b50)
		.u16(item.zip64 ? 45 : 20)
		.u16(FLAGS)
		.u16(0) // stored
		.u16(time)
		.u16(date)
		// CRC and sizes follow the data, in the descriptor.
		.u32(0)
		.u32(item.zip64 ? MAX32 : 0)
		.u32(item.zip64 ? MAX32 : 0)
		.u16(item.name.length)
		.u16(item.zip64 ? ZIP64_LOCAL_EXTRA : 0)
		.bytes(item.name);
	// The ZIP64 extra is what tells a reader the descriptor's sizes are 8 bytes.
	if (item.zip64) header.u16(0x0001).u16(16).u64(0).u64(0);
	return header.done();
};

const descriptor = (item: Planned, crc: number): Uint8Array => {
	const out = record(descriptorSize(item.zip64)).u32(0x08074b50).u32(crc);
	return item.zip64
		? out.u64(item.entry.size).u64(item.entry.size).done()
		: out.u32(item.entry.size).u32(item.entry.size).done();
};

const centralHeader = (item: Planned, crc: number): Uint8Array => {
	const { date, time } = dosDateTime(item.entry.modified);
	const header = record(
		CENTRAL + item.name.length + (item.zip64 ? ZIP64_CENTRAL_EXTRA : 0),
	)
		.u32(0x02014b50)
		.u16(MADE_BY)
		.u16(item.zip64 ? 45 : 20)
		.u16(FLAGS)
		.u16(0)
		.u16(time)
		.u16(date)
		.u32(crc)
		.u32(item.zip64 ? MAX32 : item.entry.size)
		.u32(item.zip64 ? MAX32 : item.entry.size)
		.u16(item.name.length)
		.u16(item.zip64 ? ZIP64_CENTRAL_EXTRA : 0)
		.u16(0) // comment
		.u16(0) // disk
		.u16(0) // internal attributes
		.u32(FILE_MODE)
		.u32(item.zip64 ? MAX32 : item.offset)
		.bytes(item.name);
	// Every field set to 0xFFFFFFFF above, in the order the spec lists them.
	if (item.zip64) {
		header
			.u16(0x0001)
			.u16(24)
			.u64(item.entry.size)
			.u64(item.entry.size)
			.u64(item.offset);
	}
	return header.done();
};

const end = (plan: ZipPlan): Uint8Array => {
	const count = plan.entries.length;
	const out = record((plan.zip64End ? ZIP64_END + ZIP64_LOCATOR : 0) + END);
	if (plan.zip64End) {
		const zip64EndOffset = plan.centralOffset + plan.centralSize;
		out
			.u32(0x06064b50)
			.u64(ZIP64_END - 12) // the record's size, less these two fields
			.u16(MADE_BY)
			.u16(45)
			.u32(0)
			.u32(0)
			.u64(count)
			.u64(count)
			.u64(plan.centralSize)
			.u64(plan.centralOffset)
			.u32(0x07064b50)
			.u32(0)
			.u64(zip64EndOffset)
			.u32(1);
	}
	return out
		.u32(0x06054b50)
		.u16(0)
		.u16(0)
		.u16(Math.min(count, MAX16))
		.u16(Math.min(count, MAX16))
		.u32(Math.min(plan.centralSize, MAX32))
		.u32(Math.min(plan.centralOffset, MAX32))
		.u16(0)
		.done();
};

/**
 * Writes the archive a plan describes, one chunk at a time. Fails if a file
 * turns out not to be the size it had when the plan was made, since the
 * length was promised to the browser up front.
 */
export async function* writeZip(plan: ZipPlan): AsyncGenerator<Uint8Array> {
	const crcs: number[] = [];
	for (const item of plan.entries) {
		yield localHeader(item);
		let crc = 0;
		let written = 0;
		for await (const chunk of item.entry.open()) {
			written += chunk.byteLength;
			if (written > item.entry.size) break;
			crc = crc32(chunk, crc);
			yield chunk;
		}
		if (written !== item.entry.size) {
			throw new Error(`${item.entry.name} changed size while being zipped.`);
		}
		crcs.push(crc);
		yield descriptor(item, crc);
	}
	for (const [index, item] of plan.entries.entries()) {
		yield centralHeader(item, crcs[index] ?? 0);
	}
	yield end(plan);
}
