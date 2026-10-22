import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateVideoUrl, SUPPORTED_LABELS } from './lib/urls.js';
import {
  binaryReport,
  createJob,
  getJob,
  getJobFile,
  startMaintenance,
  MAX_DURATION_SECONDS,
  formatDuration,
} from './lib/converter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
app.disable('x-powered-by');
// Render and most PaaS providers terminate TLS in front of the app.
app.set('trust proxy', 1);

app.use(express.json({ limit: '8kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "media-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'You have started several conversions recently. Please wait a few minutes and try again.' },
});

const readLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// Liveness, not a converter smoke test: the platform should keep a running
// instance that can serve the page even if a source site is being difficult.
app.get('/healthz', (req, res) => {
  const binaries = binaryReport();
  res.status(200).set('Cache-Control', 'no-store').json({
    status: binaries.ready ? 'ok' : 'degraded',
    converter: binaries.ready ? 'available' : 'unavailable',
    ytDlp: binaries.ytDlp,
    ffmpeg: binaries.ffmpeg,
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/sites', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ sites: SUPPORTED_LABELS });
});

app.post('/api/jobs', createLimiter, (req, res) => {
  const check = validateVideoUrl(req.body?.url);
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }
  const created = createJob(check.url);
  if (!created.ok) {
    return res.status(created.status || 500).json({ error: created.error });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(202).json({ job: created.job });
});

app.get('/api/jobs/:id', readLimiter, (req, res) => {
  const job = getJob(req.params.id);
  res.setHeader('Cache-Control', 'no-store');
  if (!job) {
    return res.status(404).json({ error: 'This conversion has expired. Please start a new one.' });
  }
  return res.json({ job });
});

app.get('/api/download/:id', readLimiter, (req, res, next) => {
  const file = getJobFile(req.params.id);
  if (!file) {
    return res.status(404).json({ error: 'That download has expired. Convert the link again to get a fresh file.' });
  }
  const asciiName = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(file.sizeBytes));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file.path, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown endpoint.' });
});

/* ------------------------------------------------------------------ */
/* Static site                                                         */
/* ------------------------------------------------------------------ */

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: IS_PROD ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'), (error) => {
    if (error) res.status(404).type('text/plain').send('Not found');
  });
});

app.use((error, req, res, next) => {
  console.error('[yp3] unhandled error:', error && error.message);
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  }
  return res.status(500).type('text/plain').send('Something went wrong.');
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const report = binaryReport();
if (!fs.existsSync(PUBLIC_DIR)) {
  console.error(`[yp3] Missing public directory at ${PUBLIC_DIR}`);
}
startMaintenance();

app.listen(PORT, () => {
  console.log(`[yp3] listening on http://localhost:${PORT}`);
  console.log(`[yp3] yt-dlp: ${report.ytDlp || 'NOT FOUND (run: npm run setup:ytdlp)'}`);
  if (report.ytDlp) console.log(`[yp3] yt-dlp exists: ${report.ytDlpExists}`);
  console.log(`[yp3] ffmpeg: ${report.ffmpeg || 'NOT FOUND'}`);
  console.log(`[yp3] max duration: ${formatDuration(MAX_DURATION_SECONDS)}, concurrency: ${process.env.MAX_CONCURRENT || 2}`);
});

export default app;
