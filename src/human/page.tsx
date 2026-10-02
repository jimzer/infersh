/// <reference lib="dom" />
/**
 * The built-in page behind `infer human pick | approve | rank | edit | form |
 * upload`.
 *
 * One page for every kind, switching on `infer.data.kind`. It goes through the
 * same pipeline as a page an agent writes — flattened, bundled with React and
 * Tailwind into one file, served by the human command — so it gets sharing,
 * timeouts and cleanup for free.
 *
 * Embedded in the CLI as text and passed as an inline source, so it cannot
 * import anything relative: the data shapes are restated here from
 * `presets.ts`, which builds them. Everything it answers with is documented
 * in `src/skills/references/human.md`.
 */

import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";

interface Item {
	readonly id: string | number;
	readonly label: string;
	readonly detail?: string;
	readonly image?: string;
}

interface FormField {
	readonly name: string;
	readonly label?: string;
	readonly type?: "text" | "textarea" | "number" | "select" | "checkbox";
	readonly options?: ReadonlyArray<string>;
	readonly required?: boolean;
	readonly placeholder?: string;
	readonly default?: unknown;
}

type Data =
	| {
			kind: "pick";
			prompt?: string;
			items: ReadonlyArray<Item>;
			multi: boolean;
	  }
	| { kind: "approve" | "rank"; prompt?: string; items: ReadonlyArray<Item> }
	| { kind: "edit"; prompt?: string; text: string }
	| { kind: "form"; prompt?: string; fields: ReadonlyArray<FormField> }
	| {
			kind: "upload";
			prompt?: string;
			accept: ReadonlyArray<string>;
			maxFiles?: number;
			maxBytes?: number;
			note: boolean;
	  };

declare global {
	interface Window {
		readonly infer: {
			readonly data: Data;
			submit(payload: unknown): Promise<void>;
			cancel(reason?: unknown): Promise<void>;
		};
	}
}

const data = window.infer.data;

// --- shared pieces -----------------------------------------------------------

const button =
	"rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";
const primary = `${button} bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900`;
const secondary = `${button} border border-zinc-300 dark:border-zinc-700`;
const icon =
	"grid h-8 w-8 place-items-center rounded-md border border-zinc-300 text-sm disabled:cursor-not-allowed disabled:opacity-30 dark:border-zinc-700";

/** The prompt and the actions, kept in view while a long list scrolls. */
function Header(props: {
	readonly title: string;
	readonly status?: string;
	readonly children: ReactNode;
}) {
	return (
		<header className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
			{/* Full width on a phone, so the actions wrap below the title rather
			    than squeezing it to a word per line. */}
			<div className="min-w-0 flex-1 basis-full sm:basis-auto">
				<h1 className="text-lg font-semibold">{props.title}</h1>
				{props.status ? (
					<p className="text-sm text-zinc-500">{props.status}</p>
				) : null}
			</div>
			<button
				type="button"
				className={secondary}
				onClick={() => window.infer.cancel("none of these")}
			>
				Cancel
			</button>
			{props.children}
		</header>
	);
}

function ItemBody({ item }: { readonly item: Item }) {
	return (
		<div className="flex min-w-0 flex-1 gap-3">
			{item.image ? (
				<img
					src={item.image}
					alt=""
					className="h-16 w-16 shrink-0 rounded-md object-cover"
				/>
			) : null}
			<div className="min-w-0">
				<div className="font-medium break-words">{item.label}</div>
				{item.detail ? (
					<div className="mt-1 text-sm whitespace-pre-wrap break-words text-zinc-600 dark:text-zinc-400">
						{item.detail}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** A filter box, worth having once a list no longer fits on one screen. */
function useFilter(items: ReadonlyArray<Item>) {
	const [query, setQuery] = useState("");
	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle === ""
			? items
			: items.filter((item) =>
					`${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle),
				);
	}, [items, query]);
	const box =
		items.length > 8 ? (
			<input
				type="search"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder={`Filter ${items.length} items…`}
				className="mb-3 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
			/>
		) : null;
	return { visible, box };
}

// --- pick --------------------------------------------------------------------

function Pick(props: {
	readonly prompt?: string;
	readonly items: ReadonlyArray<Item>;
	readonly multi: boolean;
}) {
	const [picked, setPicked] = useState<ReadonlyArray<Item["id"]>>([]);
	const { visible, box } = useFilter(props.items);
	const toggle = (id: Item["id"]) =>
		setPicked((current) =>
			current.includes(id)
				? current.filter((other) => other !== id)
				: props.multi
					? [...current, id]
					: [id],
		);
	return (
		<>
			<Header
				title={props.prompt ?? (props.multi ? "Pick any" : "Pick one")}
				status={`${picked.length} of ${props.items.length} selected`}
			>
				<button
					type="button"
					className={primary}
					disabled={picked.length === 0}
					onClick={() =>
						window.infer.submit({
							// The original order, not the order they were clicked in.
							picked: props.items
								.map((item) => item.id)
								.filter((id) => picked.includes(id)),
						})
					}
				>
					Submit
				</button>
			</Header>
			{box}
			<ul className="space-y-2">
				{visible.map((item) => {
					const on = picked.includes(item.id);
					return (
						<li key={String(item.id)}>
							<button
								type="button"
								onClick={() => toggle(item.id)}
								className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left ${
									on
										? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900"
										: "border-zinc-200 dark:border-zinc-800"
								}`}
							>
								<input
									type={props.multi ? "checkbox" : "radio"}
									checked={on}
									readOnly
									tabIndex={-1}
									className="mt-1"
								/>
								<ItemBody item={item} />
							</button>
						</li>
					);
				})}
			</ul>
		</>
	);
}

// --- approve -----------------------------------------------------------------

function Approve(props: {
	readonly prompt?: string;
	readonly items: ReadonlyArray<Item>;
}) {
	const [verdicts, setVerdicts] = useState<
		Readonly<Record<string, { approved: boolean; note: string }>>
	>({});
	const decided = props.items.filter((item) => String(item.id) in verdicts);
	const set = (id: Item["id"], approved: boolean) =>
		setVerdicts((current) => ({
			...current,
			[String(id)]: { approved, note: current[String(id)]?.note ?? "" },
		}));
	const all = (approved: boolean) =>
		setVerdicts(
			Object.fromEntries(
				props.items.map((item) => [
					String(item.id),
					{ approved, note: verdicts[String(item.id)]?.note ?? "" },
				]),
			),
		);
	return (
		<>
			<Header
				title={props.prompt ?? "Approve or reject each"}
				status={`${decided.length} of ${props.items.length} decided`}
			>
				<button type="button" className={secondary} onClick={() => all(true)}>
					Approve all
				</button>
				<button
					type="button"
					className={primary}
					disabled={decided.length !== props.items.length}
					onClick={() =>
						window.infer.submit({
							decisions: props.items.map((item) => {
								const verdict = verdicts[String(item.id)];
								return {
									id: item.id,
									approved: verdict?.approved ?? false,
									...(verdict?.note ? { note: verdict.note } : {}),
								};
							}),
						})
					}
				>
					Submit
				</button>
			</Header>
			<ul className="space-y-3">
				{props.items.map((item) => {
					const verdict = verdicts[String(item.id)];
					return (
						<li
							key={String(item.id)}
							className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
						>
							<div className="flex flex-wrap items-start gap-3">
								<ItemBody item={item} />
								<div className="flex gap-2">
									<button
										type="button"
										onClick={() => set(item.id, true)}
										className={`${button} ${verdict?.approved === true ? "bg-emerald-600 text-white" : "border border-zinc-300 dark:border-zinc-700"}`}
									>
										Approve
									</button>
									<button
										type="button"
										onClick={() => set(item.id, false)}
										className={`${button} ${verdict?.approved === false ? "bg-rose-600 text-white" : "border border-zinc-300 dark:border-zinc-700"}`}
									>
										Reject
									</button>
								</div>
							</div>
							{verdict ? (
								<input
									type="text"
									value={verdict.note}
									placeholder="Note (optional)"
									onChange={(event) =>
										setVerdicts((current) => ({
											...current,
											[String(item.id)]: {
												approved: verdict.approved,
												note: event.target.value,
											},
										}))
									}
									className="mt-2 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
								/>
							) : null}
						</li>
					);
				})}
			</ul>
		</>
	);
}

// --- rank --------------------------------------------------------------------

function Rank(props: {
	readonly prompt?: string;
	readonly items: ReadonlyArray<Item>;
}) {
	const [order, setOrder] = useState<ReadonlyArray<Item>>(props.items);
	// Buttons rather than drag and drop: dragging is unreliable on a phone.
	const move = (from: number, to: number) =>
		setOrder((current) => {
			if (to < 0 || to >= current.length) return current;
			const next = [...current];
			const [moved] = next.splice(from, 1);
			if (moved !== undefined) next.splice(to, 0, moved);
			return next;
		});
	return (
		<>
			<Header title={props.prompt ?? "Put these in order, best first"}>
				<button
					type="button"
					className={primary}
					onClick={() =>
						window.infer.submit({ order: order.map((item) => item.id) })
					}
				>
					Submit
				</button>
			</Header>
			<ol className="space-y-2">
				{order.map((item, index) => (
					<li
						key={String(item.id)}
						className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
					>
						<span className="w-6 shrink-0 text-right font-mono text-sm text-zinc-500">
							{index + 1}
						</span>
						<ItemBody item={item} />
						<div className="flex shrink-0 gap-1">
							<button
								type="button"
								aria-label="Move up"
								disabled={index === 0}
								onClick={() => move(index, index - 1)}
								className={icon}
							>
								↑
							</button>
							<button
								type="button"
								aria-label="Move down"
								disabled={index === order.length - 1}
								onClick={() => move(index, index + 1)}
								className={icon}
							>
								↓
							</button>
						</div>
					</li>
				))}
			</ol>
		</>
	);
}

// --- edit --------------------------------------------------------------------

function Edit(props: { readonly prompt?: string; readonly text: string }) {
	const [text, setText] = useState(props.text);
	const changed = text !== props.text;
	return (
		<>
			<Header
				title={props.prompt ?? "Edit, then submit"}
				status={`${text.length} characters${changed ? " · edited" : ""} · ⌘/Ctrl+Enter submits`}
			>
				<button
					type="button"
					className={primary}
					onClick={() => window.infer.submit({ text })}
				>
					Submit
				</button>
			</Header>
			<textarea
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						void window.infer.submit({ text });
					}
				}}
				spellCheck
				className="h-[70vh] w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm leading-relaxed dark:border-zinc-700"
			/>
		</>
	);
}

// --- form --------------------------------------------------------------------

function Form(props: {
	readonly prompt?: string;
	readonly fields: ReadonlyArray<FormField>;
}) {
	const [values, setValues] = useState<Readonly<Record<string, unknown>>>(() =>
		Object.fromEntries(
			props.fields.map((field) => [
				field.name,
				field.default ?? (field.type === "checkbox" ? false : ""),
			]),
		),
	);
	const set = (name: string, value: unknown) =>
		setValues((current) => ({ ...current, [name]: value }));
	const missing = props.fields.filter(
		(field) =>
			field.required &&
			field.type !== "checkbox" &&
			String(values[field.name] ?? "").trim() === "",
	);
	const input =
		"w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (missing.length === 0) void window.infer.submit({ values });
			}}
		>
			<Header
				title={props.prompt ?? "Fill this in"}
				status={
					missing.length > 0
						? `Required: ${missing.map((field) => field.label ?? field.name).join(", ")}`
						: undefined
				}
			>
				<button type="submit" className={primary} disabled={missing.length > 0}>
					Submit
				</button>
			</Header>
			<div className="space-y-4">
				{props.fields.map((field) => {
					const id = `field-${field.name}`;
					const label = (
						<label htmlFor={id} className="mb-1 block text-sm font-medium">
							{field.label ?? field.name}
							{field.required ? (
								<span className="text-rose-600"> *</span>
							) : null}
						</label>
					);
					const value = values[field.name];
					switch (field.type) {
						case "checkbox":
							return (
								<label key={field.name} className="flex items-center gap-2">
									<input
										id={id}
										type="checkbox"
										checked={value === true}
										onChange={(event) => set(field.name, event.target.checked)}
									/>
									<span className="text-sm font-medium">
										{field.label ?? field.name}
									</span>
								</label>
							);
						case "select":
							return (
								<div key={field.name}>
									{label}
									<select
										id={id}
										value={String(value ?? "")}
										onChange={(event) => set(field.name, event.target.value)}
										className={input}
									>
										<option value="" disabled>
											{field.placeholder ?? "Choose…"}
										</option>
										{(field.options ?? []).map((option) => (
											<option key={option} value={option}>
												{option}
											</option>
										))}
									</select>
								</div>
							);
						case "textarea":
							return (
								<div key={field.name}>
									{label}
									<textarea
										id={id}
										value={String(value ?? "")}
										placeholder={field.placeholder}
										onChange={(event) => set(field.name, event.target.value)}
										className={`${input} h-32`}
									/>
								</div>
							);
						default:
							return (
								<div key={field.name}>
									{label}
									<input
										id={id}
										type={field.type === "number" ? "number" : "text"}
										value={String(value ?? "")}
										placeholder={field.placeholder}
										onChange={(event) =>
											set(
												field.name,
												field.type === "number" && event.target.value !== ""
													? Number(event.target.value)
													: event.target.value,
											)
										}
										className={input}
									/>
								</div>
							);
					}
				})}
			</div>
		</form>
	);
}

// --- upload ------------------------------------------------------------------

/** One file the human added, and how far it has got. */
interface Sending {
	readonly key: number;
	readonly file: File;
	readonly state: "queued" | "sending" | "done" | "failed";
	readonly loaded: number;
	/** The server's id for it, once saved. */
	readonly id?: string;
	readonly error?: string;
}

/** How many files stream at once: enough to fill the link, few enough to finish. */
const PARALLEL = 3;

/** The token is the page's own path, and the server wants it back on every call. */
const TOKEN = location.pathname.split("/").filter(Boolean).pop() ?? "";

const formatSize = (bytes: number): string => {
	for (const [unit, size] of [
		["GB", 1024 ** 3],
		["MB", 1024 ** 2],
		["KB", 1024],
	] as const) {
		if (bytes >= size) return `${Number((bytes / size).toFixed(1))} ${unit}`;
	}
	return `${bytes} B`;
};

/**
 * The server's rule, restated so a wrong file is refused before it is sent.
 * A file the browser gives no type is left to the server, which can still
 * tell it by its extension.
 */
const accepts = (accept: ReadonlyArray<string>, file: File): boolean =>
	accept.length === 0 ||
	accept.some((token) =>
		token.startsWith(".")
			? file.name.toLowerCase().endsWith(token)
			: file.type === "" ||
				(token.endsWith("/*")
					? file.type.toLowerCase().startsWith(token.slice(0, -1))
					: file.type.toLowerCase() === token),
	);

function Upload(props: {
	readonly prompt?: string;
	readonly accept: ReadonlyArray<string>;
	readonly maxFiles?: number;
	readonly maxBytes?: number;
	readonly note: boolean;
}) {
	const [files, setFiles] = useState<ReadonlyArray<Sending>>([]);
	const [note, setNote] = useState("");
	const [dragging, setDragging] = useState(false);
	const requests = useRef(new Map<number, XMLHttpRequest>());
	const nextKey = useRef(0);

	const update = useCallback(
		(key: number, change: Partial<Sending>) =>
			setFiles((current) =>
				current.map((entry) =>
					entry.key === key ? { ...entry, ...change } : entry,
				),
			),
		[],
	);

	const add = useCallback(
		(incoming: ReadonlyArray<File>) =>
			setFiles((current) => {
				let live = current.filter((entry) => entry.state !== "failed").length;
				const added = incoming.map((file): Sending => {
					const key = nextKey.current++;
					const refuse = (error: string): Sending => ({
						key,
						file,
						state: "failed",
						loaded: 0,
						error,
					});
					if (!accepts(props.accept, file)) {
						return refuse(`Not accepted: only ${props.accept.join(", ")}.`);
					}
					if (props.maxBytes !== undefined && file.size > props.maxBytes) {
						return refuse(
							`Too large: the limit is ${formatSize(props.maxBytes)}.`,
						);
					}
					if (props.maxFiles !== undefined && live >= props.maxFiles) {
						return refuse(
							`Too many: at most ${props.maxFiles} file${props.maxFiles === 1 ? "" : "s"}.`,
						);
					}
					live++;
					return { key, file, state: "queued", loaded: 0 };
				});
				return [...current, ...added];
			}),
		[props.accept, props.maxBytes, props.maxFiles],
	);

	// Each file streams as soon as there is room, so most are already on the
	// other machine by the time the human presses Send.
	useEffect(() => {
		const sending = files.filter((entry) => entry.state === "sending").length;
		const start = files
			.filter((entry) => entry.state === "queued")
			.slice(0, Math.max(0, PARALLEL - sending));
		for (const entry of start) {
			const request = new XMLHttpRequest();
			requests.current.set(entry.key, request);
			request.open("POST", "/api/upload");
			request.setRequestHeader("x-infer-token", TOKEN);
			request.setRequestHeader(
				"x-infer-name",
				encodeURIComponent(entry.file.name),
			);
			if (entry.file.type) {
				request.setRequestHeader("x-infer-type", entry.file.type);
			}
			request.upload.onprogress = (event) =>
				update(entry.key, { loaded: event.loaded });
			request.onload = () => {
				requests.current.delete(entry.key);
				let body: { id?: string; error?: string } = {};
				try {
					body = JSON.parse(request.responseText);
				} catch {}
				update(
					entry.key,
					request.status === 200 && body.id
						? { state: "done", id: body.id, loaded: entry.file.size }
						: {
								state: "failed",
								error: body.error ?? `Not sent (${request.status}).`,
							},
				);
			};
			request.onerror = () => {
				requests.current.delete(entry.key);
				update(entry.key, {
					state: "failed",
					error: "The connection dropped. Remove it and add it again.",
				});
			};
			request.send(entry.file);
		}
		if (start.length > 0) {
			const keys = new Set(start.map((entry) => entry.key));
			setFiles((current) =>
				current.map((entry) =>
					keys.has(entry.key) ? { ...entry, state: "sending" } : entry,
				),
			);
		}
	}, [files, update]);

	// The whole page takes a drop, so a file that misses the box is not
	// opened by the browser in place of the page.
	useEffect(() => {
		const over = (event: DragEvent) => {
			event.preventDefault();
			setDragging(true);
		};
		const leave = (event: DragEvent) => {
			if (event.relatedTarget === null) setDragging(false);
		};
		const drop = (event: DragEvent) => {
			event.preventDefault();
			setDragging(false);
			add(Array.from(event.dataTransfer?.files ?? []));
		};
		window.addEventListener("dragover", over);
		window.addEventListener("dragleave", leave);
		window.addEventListener("drop", drop);
		return () => {
			window.removeEventListener("dragover", over);
			window.removeEventListener("dragleave", leave);
			window.removeEventListener("drop", drop);
		};
	}, [add]);

	const remove = (entry: Sending) => {
		requests.current.get(entry.key)?.abort();
		requests.current.delete(entry.key);
		if (entry.id) {
			void fetch(`/api/upload/${encodeURIComponent(entry.id)}`, {
				method: "DELETE",
				headers: { "x-infer-token": TOKEN },
			});
		}
		setFiles((current) => current.filter((other) => other.key !== entry.key));
	};

	const done = files.filter((entry) => entry.state === "done");
	const pending = files.filter(
		(entry) => entry.state === "queued" || entry.state === "sending",
	);
	const status =
		files.length === 0
			? undefined
			: pending.length > 0
				? `${done.length} of ${done.length + pending.length} uploaded…`
				: `${done.length} file${done.length === 1 ? "" : "s"} ready to send`;
	const limits = [
		props.accept.length > 0 ? props.accept.join(", ") : "Any file",
		props.maxFiles !== undefined
			? `up to ${props.maxFiles} file${props.maxFiles === 1 ? "" : "s"}`
			: undefined,
		props.maxBytes !== undefined
			? `${formatSize(props.maxBytes)} each`
			: undefined,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<>
			<Header title={props.prompt ?? "Send files"} status={status}>
				<button
					type="button"
					className={primary}
					disabled={done.length === 0 || pending.length > 0}
					onClick={() =>
						window.infer.submit({
							files: done.map((entry) => entry.id),
							...(note.trim() ? { note } : {}),
						})
					}
				>
					Send
				</button>
			</Header>
			<label
				htmlFor="infer-files"
				className={`flex min-h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
					dragging
						? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900"
						: "border-zinc-300 dark:border-zinc-700"
				}`}
			>
				<span className="text-3xl" aria-hidden>
					⬆
				</span>
				<span className="font-medium">
					<span className="hidden sm:inline">Drop files here, or </span>
					<span className="underline">choose files</span>
				</span>
				<span className="text-sm text-zinc-500">{limits}</span>
				<input
					id="infer-files"
					type="file"
					multiple={props.maxFiles !== 1}
					accept={props.accept.join(",") || undefined}
					className="sr-only"
					onChange={(event) => {
						add(Array.from(event.target.files ?? []));
						// Cleared, so choosing the same file again still counts.
						event.target.value = "";
					}}
				/>
			</label>
			{files.length > 0 ? (
				<ul className="mt-4 space-y-2">
					{files.map((entry) => {
						const percent =
							entry.file.size === 0
								? entry.state === "done"
									? 100
									: 0
								: Math.round((entry.loaded / entry.file.size) * 100);
						return (
							<li
								key={entry.key}
								data-state={entry.state}
								className={`rounded-lg border p-3 ${
									entry.state === "failed"
										? "border-rose-300 dark:border-rose-800"
										: "border-zinc-200 dark:border-zinc-800"
								}`}
							>
								<div className="flex items-center gap-3">
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium">
											{entry.file.name}
										</div>
										<div className="text-sm text-zinc-500">
											{formatSize(entry.file.size)}
											{entry.state === "sending" ? ` · ${percent}%` : ""}
											{entry.state === "queued" ? " · waiting" : ""}
											{entry.state === "done" ? " · uploaded" : ""}
										</div>
										{entry.error ? (
											<div className="text-sm text-rose-600 dark:text-rose-400">
												{entry.error}
											</div>
										) : null}
									</div>
									<button
										type="button"
										aria-label={`Remove ${entry.file.name}`}
										onClick={() => remove(entry)}
										className={icon}
									>
										✕
									</button>
								</div>
								{entry.state === "sending" || entry.state === "queued" ? (
									<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
										<div
											className="h-full bg-zinc-900 transition-[width] dark:bg-zinc-100"
											style={{ width: `${percent}%` }}
										/>
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			) : null}
			{props.note ? (
				<div className="mt-4">
					<label
						htmlFor="infer-note"
						className="mb-1 block text-sm font-medium"
					>
						Note <span className="font-normal text-zinc-500">(optional)</span>
					</label>
					<textarea
						id="infer-note"
						value={note}
						onChange={(event) => setNote(event.target.value)}
						placeholder="Anything to say about these files"
						className="h-24 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
					/>
				</div>
			) : null}
		</>
	);
}

// --- mount -------------------------------------------------------------------

function Page() {
	switch (data.kind) {
		case "pick":
			return (
				<Pick prompt={data.prompt} items={data.items} multi={data.multi} />
			);
		case "approve":
			return <Approve prompt={data.prompt} items={data.items} />;
		case "rank":
			return <Rank prompt={data.prompt} items={data.items} />;
		case "edit":
			return <Edit prompt={data.prompt} text={data.text} />;
		case "form":
			return <Form prompt={data.prompt} fields={data.fields} />;
		case "upload":
			return (
				<Upload
					prompt={data.prompt}
					accept={data.accept}
					maxFiles={data.maxFiles}
					maxBytes={data.maxBytes}
					note={data.note}
				/>
			);
	}
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="mx-auto max-w-3xl px-4 pb-8">
			<Page />
		</main>,
	);
}
