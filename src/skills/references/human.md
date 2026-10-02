# infer human

Ask the person at the keyboard, through a real web page, and get their answer
back — or files from them. Needs no API key.

## Reach for a built-in page first

Most questions have one of five shapes, and those need **no page code** — pass
the data and get the answer:

```bash
infer human pick    --items drafts.json --label title --detail body --multi   # {"picked":[<id>,…]}
infer human approve --items findings.json --label title --detail why          # {"decisions":[{"id","approved","note"?},…]}
infer human rank    --items titles.json --label title                         # {"order":[<id>,…]}
infer human edit    --text draft.md                                           # {"text":"…"}
infer human form    --fields form.json                                        # {"values":{"<name>":…}}
```

- `--items` is any JSON array, inline or a path. Strings show as they are;
  objects show `--label` (or their first string field), with `--detail` beneath
  and `--image` beside — a URL, or a local path, which is embedded.
- Answers name items by `--id` (a field), or by position from 0 when it is not
  given. Pass `--id` whenever items have a stable key, so the answer does not
  depend on list order.
- `--prompt` is the question at the top of the page — say what the choice is
  *for*: "Which should I post today?", not "Pick".
- `pick` is one item unless `--multi`; `approve` needs a verdict on every item;
  `rank` uses up/down buttons, so it works on a phone; `edit` never modifies the
  file it read; `form` fields are `text`, `textarea`, `number`, `select` (with
  `options`) or `checkbox`, and `required` ones must be filled.
- The output is the same as `ask`: `{status, payload, elapsedMs, url}`. Only
  `submitted` carries an answer.

## Getting files from the human

`upload` is the other direction: the human sends **you** files — a photo from
their phone, a signed PDF, a screen recording.

```bash
infer human upload --prompt 'Photos of the damage' --accept 'image/*' --share
infer human upload --out assets/raw --accept 'video/*,.mov' --max-files 1 --max-size 2GB
```

- They drop files on the page, or tap to pick them (or take a photo, on a
  phone), may add a note, and press Send. Each file streams to disk as it is
  added, so a multi-GB video is fine.
- Files land in `--out` (default `uploads/<date-time>`, created). Nothing is
  overwritten: a second `report.pdf` becomes `report (2).pdf`.
- **stdout is the saved absolute paths, one per line** — read them directly.
  The note goes to stderr (`Note: …`) so the paths stay parseable; pass
  `--json` when you need the note or the status:
  `{status, payload: {files: [{path, name, size, type}], note?}, elapsedMs, url}`,
  where `name` is the file's name on their device and `size` is in bytes.
- **Empty stdout means nothing was sent**: they cancelled, or the timeout hit
  (stderr says which). Nothing is left in the folder then — files they had
  added are deleted, as are files they removed before Send.
- `--accept` takes what an HTML `accept` attribute does (`image/*,.pdf`); the
  picker shows only those, and the server refuses anything else. `--max-size`
  (`25MB`, `1.5GB`) and `--max-files` are enforced by the server too, and the
  page says why a file was refused. `--no-note` hides the note field.
- Use `--share` when the files are on their phone.

Write a page of your own only when none of these fits:

```bash
infer human ask ./pick.tsx --data posts.json      # they answer; you get their JSON
infer human present ./report.tsx --data run.json  # they read; you get "done"
```

The page is a `.tsx` file you write; everything else — bundling, serving, the
URL, the round trip — is handled.

## What it is for

Anything where a list in the terminal is the wrong shape for the decision:

- twenty generated drafts, and you need to know which six to keep, in what order
- forty review findings, and you need to know which to fix
- a table of query results, and you need rows picked
- a long report you want read *before* you carry on

`present` is a review gate, not a notification. It blocks until they click
Done, so a `done` status means they actually looked.

## The contract

Write a `.tsx` that renders into `#root`. The harness gives every page one
global, and that is the whole API:

```tsx
infer.data              // whatever --data held, already parsed
infer.submit(anything)  // send JSON back and end the command
infer.cancel(reason)    // "none of these" — different from not answering
```

`submit` takes any JSON you like. Nothing validates or reshapes it; it comes
back as `payload` exactly as sent. You write both the page and the code that
reads the answer, so no schema has to be agreed in advance.

```tsx
import { createRoot } from "react-dom/client";
import { useState } from "react";

const posts = (window as any).infer.data as { id: number; text: string }[];

function Pick() {
  const [kept, setKept] = useState<number[]>([]);
  return (
    <main className="p-6 max-w-2xl mx-auto">
      {posts.map((p) => (
        <label key={p.id} className="flex gap-3 py-3 border-b">
          <input
            type="checkbox"
            onChange={(e) =>
              setKept((k) => (e.target.checked ? [...k, p.id] : k.filter((i) => i !== p.id)))
            }
          />
          <span>{p.text}</span>
        </label>
      ))}
      <button className="mt-6 px-4 py-2 rounded bg-black text-white"
              onClick={() => (window as any).infer.submit({ kept })}>
        Keep {kept.length}
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Pick />);
```

To hand the user a page to **keep** rather than ask them something, use
`infer render html` instead: it writes one self-contained file and needs no
running CLI. See [render.md](render.md).

Tailwind v4 is inlined by default, so class names work with nothing to set up
and no network. If you know Tailwind from v3: `bg-opacity-*` is gone (use
`bg-black/50`), and a bare `border` takes the text colour rather than grey.
[render.md](render.md) has the full list.
`react` and anything else you import are installed on demand — the file does
not need a project around it, and relative imports of your own files are
inlined.

## Keep the content in --data, not in the page

`--data` takes inline JSON or a path to a `.json` file and hands it to the page
as `infer.data`. Put the content there and the *same* page works for every
run:

```bash
infer human ask ./pick.tsx --data '{"posts":[...]}'
infer human ask ./pick.tsx --data drafts.json
```

Writing twenty drafts into the `.tsx` instead means regenerating the page every
time. Written once and reused, most runs need no new code at all.

## Reading the answer

stdout is always one JSON object:

```json
{ "status": "submitted", "payload": { "kept": [1, 4, 7] }, "elapsedMs": 61840,
  "url": "http://127.0.0.1:54700/0c1aea32c91d1447" }
```

Branch on `status`, never on `payload` alone:

| status | means |
| --- | --- |
| `submitted` | they answered; `payload` is theirs |
| `done` | `present` only — they read it |
| `cancelled` | they declined on purpose |
| `timeout` | **they never answered** |

**A timeout is not consent.** The command still exits 0, because "no answer" is
an answer worth reporting rather than a crash. Say the page timed out and ask
what to do. Never fall back to defaults, never assume approval, and never
pretend the work was reviewed.

`cancelled` and `timeout` are different: one is a decision, the other is
silence. Treat them differently.

## Local by default; `--share` only for another device

By default the page is served on `http://127.0.0.1:…`, with no Tailscale
involved. **That is right whenever the user is at this computer**: give them
the link, or pass `--open` to open it in their browser. A localhost page is a
secure context, so the clipboard and every other browser API work.

Add `--share` only when the user will open the page on **another device** — a
phone, another laptop:

```bash
infer human ask ./pick.tsx --data posts.json --share
```

It publishes through `tailscale serve` in the foreground, giving an HTTPS URL
on the user's tailnet; the server itself stays on localhost. The share lives
exactly as long as the command — it never touches other `tailscale serve`
rules, several can run at once, and nothing is left behind however the command
ends. Needs Tailscale on this machine and on the device opening the link.

## Traps

- **This command blocks.** That is the point: the server only lives as long as
  the command. Give a real `--timeout` (seconds) for how long the user might
  plausibly take — `ask` defaults to 5 minutes, `present` and the built-in
  pages to 15 — and run it in
  the background if it may run longer than your own tool timeout.
- **Never poll or re-run to "check" an answer.** Re-running serves a new page
  at a new URL and abandons the one they are looking at.
- **Page errors land on stderr**, prefixed `page:`. If the page came back blank,
  read them; that is the whole diagnosis.
- **Every page carries a raw-JSON escape hatch** in the bottom bar, so a broken
  page can still be answered by hand. If a user says they used it, the page
  code was wrong — fix it rather than shrugging.
- The URL contains a random token and is the only access control. Do not
  reprint it anywhere it would outlive the run.
