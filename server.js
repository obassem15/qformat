/**
 * qformat-pdf-service
 * --------------------
 * HTTP service that powers QFormat's "High Quality PDF" export option.
 * It receives a full HTML snapshot of the current document (the same
 * markup + inline CSS custom properties the live preview is using) and
 * renders it to a real PDF with headless Chromium, so the output has
 * selectable/searchable vector text instead of a JPEG image.
 *
 * QFormat already ships CSS rules under `@media print` that isolate
 * #printArea and force one .paper element per PDF page. Puppeteer's
 * page.pdf() applies the print media type by default, so those existing
 * rules do all the pagination work here — this server does not need to
 * know anything about QFormat's themes/layouts/pagination logic.
 *
 * This service is meant to be deployed once (Docker container on
 * Render/Railway/Fly.io/Cloud Run/a VPS — see README.md), so that every
 * QFormat user hits a shared public URL instead of running Node +
 * Puppeteer + Chromium locally. Nothing here requires local execution;
 * `npm start` still works for local dev, it's just no longer the only
 * way to use High Quality PDF.
 *
 * Local dev:
 *   npm install
 *   npm start
 *
 * Production: see README.md / Dockerfile.
 */

const express = require('express');
const cors = require('cors');

process.env.HOME = process.env.HOME || '/tmp';
process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || '/tmp/puppeteer';
const puppeteer = require('puppeteer');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const REQUEST_TIMEOUT_MS = process.env.REQUEST_TIMEOUT_MS
  ? Number(process.env.REQUEST_TIMEOUT_MS)
  : 60_000;

// Comma-separated list of allowed origins for the deployed frontend, e.g.
// "https://qformat.example.com,https://www.qformat.example.com". If unset,
// all origins are allowed (fine for local dev; set this in production so
// the public export endpoint can't be embedded/abused by other sites).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = ALLOWED_ORIGINS.length
  ? {
      origin(origin, callback) {
        // Allow same-origin/non-browser requests (no Origin header) too.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`Origin not allowed: ${origin}`));
      },
    }
  : {};

const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// A single headless browser instance is kept warm and reused across
// requests (fast, avoids paying Chromium startup cost per export). Each
// export still gets its own fresh page/tab.
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      if (browser.isConnected()) return browser;
    } catch (_e) {
      // fall through and relaunch
    }
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    headless: true,
    // PUPPETEER_EXECUTABLE_PATH lets a container point at a system-installed
    // Chromium (see Dockerfile) instead of Puppeteer's bundled download.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // avoids crashes in memory-constrained containers
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  });
  return browserPromise;
}

function sanitizeFilename(name) {
  const fallback = 'document.pdf';
  if (!name || typeof name !== 'string') return fallback;
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '-').trim();
  return cleaned || fallback;
}

// Accepts "210mm" / "297mm" style strings (what QFormat sends) and makes
// sure nothing unexpected slips through into Puppeteer's pdf() options.
function sanitizeDimension(value, label) {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?(mm|cm|in|px)$/.test(value.trim())) {
    throw new Error(`Invalid "${label}" value: ${JSON.stringify(value)}`);
  }
  return value.trim();
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'qformat-pdf-service', endpoint: 'POST /export-pdf' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'qformat-pdf-service' });
});

app.post('/export-pdf', async (req, res) => {
  const { html, width, height, filename } = req.body || {};

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Request body is missing "html".' });
  }

  let pageWidth;
  let pageHeight;
  try {
    pageWidth = sanitizeDimension(width, 'width');
    pageHeight = sanitizeDimension(height, 'height');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let page;
  const timeout = setTimeout(() => {
    if (page) page.close().catch(() => {});
  }, REQUEST_TIMEOUT_MS);

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Wide-ish viewport so nothing hits the app's narrow-screen layout
    // rules before @media print takes over and hides everything but
    // #printArea anyway.
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });

    await page.setContent(html, { waitUntil: 'networkidle0', timeout: REQUEST_TIMEOUT_MS });

    // Make sure web fonts (Google Fonts links in <head>) have actually
    // finished loading before we rasterize — otherwise text can render
    // in a fallback font on the first paint.
    await page.evaluate(() => (document.fonts && document.fonts.ready) || Promise.resolve());

    await page.emulateMediaType('print');

    const pdfBuffer = await page.pdf({
      width: pageWidth,
      height: pageHeight,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });

    const safeName = sanitizeFilename(filename);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('[qformat-pdf-service] export failed:', err);
    res.status(500).json({ error: err.message || 'PDF export failed.' });
  } finally {
    clearTimeout(timeout);
    if (page) {
      try {
        await page.close();
      } catch (_e) {
        /* already closed / timed out */
      }
    }
  }
});

app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// CORS rejections (and anything else that throws synchronously in
// middleware) land here instead of falling through to Express's default
// HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[qformat-pdf-service] request error:', err.message);
  res.status(err.message?.startsWith('Origin not allowed') ? 403 : 500).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`QFormat PDF service listening on http://localhost:${PORT}`);
  console.log('Export endpoint: POST /export-pdf');
});

async function shutdown() {
  console.log('\nShutting down qformat-pdf-service...');
  server.close();
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch (_e) {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
