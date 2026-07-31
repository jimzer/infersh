# infer ui

Show the user a real web page in their browser, and get an answer back.

```bash
infer ui ask ./pick.tsx --data posts.json      # they answer; you get their JSON
infer ui present ./report.tsx --data run.json  # they read; you get "done"
```

Needs no API key. The page is a `.tsx` file you write; everything else —
bundling, serving, the URL, the round trip — is handled.

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

Tailwind is injected by default, so class names work with nothing to set up.
`react` and anything else you import are installed on demand — the file does
not need a project around it, and relative imports of your own files are
inlined.

## Keep the content in --data, not in the page

`--data` takes inline JSON or a path to a `.json` file and hands it to the page
as `infer.data`. Put the content there and the *same* page works for every
run:

```bash
infer ui ask ./pick.tsx --data '{"posts":[...]}'
infer ui ask ./pick.tsx --data drafts.json
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

## Getting it onto a phone

```bash
infer ui ask ./pick.tsx --data posts.json --share
```

`--share` publishes through `tailscale serve`, giving an HTTPS URL on the
user's tailnet. The server itself stays on localhost, and the share is cleared
when the command ends. Needs Tailscale running on the machine.

Prefer it whenever the page might be read away from the desk, and whenever the
page copies text — HTTPS is what makes `navigator.clipboard` work at all.

## Traps

- **This command blocks.** That is the point: the server only lives as long as
  the command. Give a real `--timeout` (seconds) for how long the user might
  plausibly take — `ask` defaults to 5 minutes, `present` to 15 — and run it in
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
