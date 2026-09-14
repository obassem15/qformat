# qformat-pdf-service

The service that powers QFormat's **High Quality PDF** export option. It
receives the current document as an HTML snapshot and renders it to a real
PDF using headless Chromium (Puppeteer) — so the text is actual
selectable/searchable PDF text and borders/decorations stay vector-sharp at
any zoom, instead of the pixelated JPEG-in-a-PDF you get from the old
html2canvas pipeline.

QFormat's **Quick PDF** option still works with zero setup — it doesn't
need this service at all.

This service is now meant to be **deployed once, publicly**, so every
QFormat user gets High Quality PDF automatically with no local install.
(Local `npm start` still works too, for development.)

## Deploy it (one time, by whoever maintains QFormat)

This repo includes a `Dockerfile`, so it deploys as-is to any host that
runs Docker containers. Render is the easiest option:

1. Push this `qformat-pdf-service` folder to a GitHub repo (or a
   subfolder of your QFormat repo).
2. In [Render](https://render.com): **New → Blueprint**, point it at the
   repo (it will pick up `render.yaml`), or **New → Web Service** and
   choose "Docker" as the environment manually.
3. Set the `ALLOWED_ORIGINS` environment variable to your deployed
   QFormat URL(s), e.g. `https://qformat.example.com`.
4. Deploy. Render gives you a public URL like
   `https://qformat-pdf-service.onrender.com`.
5. In the QFormat frontend, point `PDF_SERVICE_URL` at
   `https://qformat-pdf-service.onrender.com/export-pdf` (see the main
   project README — it's one constant near the top of the export script).

Any other Docker-friendly host works the same way (Railway, Fly.io, Google
Cloud Run, a plain VPS with `docker run`, ...). There's nothing
Render-specific about the image itself.

```bash
# Generic manual deploy, e.g. on a VPS:
docker build -t qformat-pdf-service .
docker run -d -p 5174:5174 \
  -e ALLOWED_ORIGINS=https://qformat.example.com \
  --name qformat-pdf-service \
  qformat-pdf-service
```

### Why a container instead of a serverless function?

Puppeteer needs a full Chromium binary plus its shared-library
dependencies, keeps a warm browser instance between requests for speed,
and print-to-PDF renders can run several seconds — that combination fits
a small always-on container (Render/Railway/Fly free-to-cheap tiers all
work fine) much better than a size-constrained, cold-starting serverless
function. The `Dockerfile` here installs Chromium via `apt-get` (not
Puppeteer's own downloader) specifically so the image builds reliably in
CI/on any host.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no | Port to listen on. Most hosts set this for you. Defaults to `5174`. |
| `ALLOWED_ORIGINS` | recommended in prod | Comma-separated list of frontend origins allowed to call `/export-pdf`. Unset = allow any origin. |
| `REQUEST_TIMEOUT_MS` | no | Per-export timeout. Defaults to `60000`. |
| `PUPPETEER_EXECUTABLE_PATH` | set by Dockerfile | Path to system Chromium. Don't set manually unless running outside Docker. |

See `.env.example`.

## Local development

Requires [Node.js](https://nodejs.org) 18+.

```bash
cd qformat-pdf-service
npm install
npm start
```

The first `npm install` downloads Puppeteer's bundled Chromium (~200MB;
needs internet, one-time). You should see:

```
QFormat PDF service listening on http://localhost:5174
Export endpoint: POST /export-pdf
```

Point the frontend's `PDF_SERVICE_URL` at `http://localhost:5174/export-pdf`
while developing.

## How it works

1. QFormat clones the live document `<html>` (current theme, layout,
   decoration, colors, fonts — everything already applied as inline CSS
   custom properties) into a standalone HTML string and `POST`s it here
   along with the target page width/height and a filename.
2. This service opens the HTML in headless Chromium and calls Chromium's
   native print-to-PDF (`page.pdf()`), which renders using the page's
   existing `@media print` rules — the same rules QFormat already uses to
   isolate `#printArea` and force one page per `.paper` element.
3. The resulting PDF buffer is streamed back and downloaded by the browser.

No parsing, layout, or pagination logic lives in this service — it's a
thin wrapper around Chromium's own PDF renderer, so the output always
matches whatever QFormat's preview is currently showing.

## Troubleshooting

- **"Could not reach the PDF service..."** — check `PDF_SERVICE_URL` in
  the frontend matches your deployed service's `/export-pdf` URL, and that
  the service is actually up (`GET /health` should return `{"ok":true}`).
- **CORS error in the browser console** — add your frontend's exact origin
  (scheme + host, no trailing slash) to `ALLOWED_ORIGINS` on the deployed
  service and redeploy/restart it.
- **Slow first export after idle** — free tiers on some hosts (e.g. Render
  free plan) spin containers down when idle; the first request after a
  while pays a cold-start cost. Upgrading to an always-on plan avoids this.
- **Puppeteer download fails during local `npm install`** — some corporate
  networks block the Chromium download. See Puppeteer's docs on using an
  existing Chrome install (`PUPPETEER_EXECUTABLE_PATH`) as a workaround.
- **Fonts look slightly off** — the service waits for `document.fonts.ready`
  before rendering, but it still needs internet access to fetch the same
  Google Fonts QFormat's preview uses.
