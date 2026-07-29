# infer fal

Run fal.ai models — image and video generation, editing, and anything else fal
hosts.

```bash
infer fal models --q "text to image"      # find a model
infer fal schema fal-ai/flux/dev          # see what it accepts
infer fal run fal-ai/flux/schnell --input '{"prompt":"a red apple"}'
infer fal cdn ./cat.png                   # upload a file, print its URL
```

Needs `FAL_KEY`, except `models` which only gets a higher rate limit with one.

## Work in this order

**Never guess an endpoint ID or its fields.** Model inputs vary wildly between
models, so:

1. `infer fal models --q "…"` or `--category image-to-video` to find candidates.
   Prints one endpoint ID per line, so it pipes.
2. `infer fal schema <endpoint-id>` to see the exact accepted fields, their
   types, defaults and which are required. Every `$ref` is resolved, so the
   output is self-contained. `| jq '.required'` for just the required ones.
3. `infer fal run <endpoint-id> --input '<json>'`.

Skipping step 2 is the most common way to waste a paid call.

## Local files are uploaded automatically

Any value in `--input` that is **a path to an existing local file** is uploaded
to the fal CDN and replaced by its URL — at any depth, whatever the field is
called:

```bash
infer fal run fal-ai/flux/dev/image-to-image \
  --input '{"prompt":"make it snowy","image_url":"./photo.jpg"}'
# uploaded ./photo.jpg -> https://v3b.fal.media/files/…
```

So pass a path wherever a model wants an asset URL. The mapping is printed to
stderr. Use `infer fal cdn` only when you want to upload once and reuse the URL
across several runs.

## Getting the output

By default `run` prints the raw result JSON:

```bash
infer fal run … | jq -r '.images[0].url'
```

With `--output` it downloads the produced assets instead and prints the paths:

```bash
infer fal run … --output ./apple.jpg          # one asset → exactly that path
infer fal run … --output ./shots/             # a directory → model's own names
```

Several assets with a file target are numbered `out.png`, `out-2.png`. The raw
JSON still goes to stderr, so the seed and timings are not lost.

**Prefer `--output` when the user wants files.** It saves a download step and
the URLs expire.

## Cost

Every `run` is billed. Before running:

- Check the schema for a count field (`num_images`, `num_frames`) and set it
  low while iterating.
- Prefer a cheap fast model to try the shape of a prompt (`fal-ai/flux/schnell`)
  before a slow expensive one.
- Do not re-run to "see if it works" — read the error instead. Validation
  failures are reported with fal's own detail, which usually names the field.
