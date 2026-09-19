# The preview build

A build of the real front end with the server replaced by a mock that runs in
the browser. It produces a folder of static files that can be opened from disk,
served from anything, or published as a Claude artifact — so the UI can be
looked at, linked to and shown to someone without a database, a queue, or a
deploy.

```bash
npm run dev:preview      # iterate on http://localhost:5174, with HMR
npm run build:preview    # -> client/dist-preview/
npm run --workspace client serve:preview   # serve that folder to check it
```

## What is real and what is not

Only `client/src/api/client.ts` is replaced. Everything above it — `App.tsx`,
every component, every hook, the event fold in `state/processing.ts`, the
Tailwind styling — is the same source the real build uses, so the preview shows
the app's own behaviour rather than a second implementation of it that has to
be kept in step.

What the mock provides:

| | |
| --- | --- |
| Documents, regions, batches | In memory, seeded with three processed invoices |
| Page images | An SVG invoice, drawn per document from its id |
| Text layer | The same positioned runs the image was drawn from |
| OCR | Reads the runs under the region; confidences span all three bands |
| Progress socket | A `WebSocket` stand-in replaying the real event frames |
| Uploads | Accepted, progress-reported, cancellable, duplicate-detected |

So drawing a box over "Invoice number" and running OCR really does return that
invoice's number: the image, the text layer and the OCR answers all come from
one model in `client/src/preview/invoice.ts`. Nothing persists — a reload is a
fresh database with the three seeds back in it.

What it cannot show, because none of it exists client-side: real PDF rendering,
real Tesseract output, real field detection, duplicate detection by content
hash, anything about the queue's retry behaviour, and any server error that
isn't simulated.

## Query flags

| Flag | Effect |
| --- | --- |
| `?slow` | Triples every simulated delay, to watch a transition properly |
| `?fail=4` | Fails every 4th uploaded document, for the error states |

## Publishing it as a Claude artifact

An artifact is a static page hosted at a private `claude.ai` URL, served from a
sandboxed origin with no server behind it — which is exactly the shape this
build has. Ask Claude Code to publish `client/dist-preview/` and it will upload
`index.html` as the page with the files under `assets/` alongside it. Updating
the same artifact later keeps the same URL, so the link can be shared once and
refreshed as often as you like.

Two things the bundle already does for that to work:

- `base: './'`, so every asset URL is relative. An artifact is not served from
  the root of its origin.
- No sourcemaps, so the upload stays small.

## Layout

```
client/
  vite.preview.config.ts     The alias, the output dir, the "preview" badge
  src/preview/
    fake-api.ts              Replaces src/api/client.ts. The only seam.
    backend.ts               In-memory store, pipeline timers, socket stand-in
    invoice.ts               The synthetic invoice: image, text layer, OCR
    contract.ts              Fails the build if the mock stops matching
```

## Keeping it honest

`contract.ts` assigns the mock to `typeof import('../api/client')`, so `tsc -b`
— which `build:preview` runs first — rejects a mock that has lost a function or
drifted on a signature. The alias happens at bundle time, where TypeScript is
not looking, so without that check a mismatch would build cleanly and fail in
the browser.

When you add an endpoint to `src/api/client.ts`, the preview build is what
tells you the mock needs it too.
