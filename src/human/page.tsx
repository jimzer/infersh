/// <reference lib="dom" />
/**
 * The built-in page behind `infer human pick | approve | rank | edit | form`.
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

import { type ReactNode, useMemo, useState } from "react";
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
	| { kind: "form"; prompt?: string; fields: ReadonlyArray<FormField> };

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
