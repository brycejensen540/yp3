/**
 * Video -> MP3 conversion engine.
 *
 * yt-dlp fetches the best available audio stream and ffmpeg re-encodes it to a
 * constant 320 kbps MP3. Jobs are queued, run at most MAX_CONCURRENT at a time,
 * and every artefact is removed after JOB_TTL_MS.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const IS_WIN = process.platform === 'win32';
export const WORK_DIR = process.env.WORK_DIR
  ? path.resolve(process.env.WORK_DIR)
  : path.join(ROOT, 'tmp');

const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 45 * 60 * 1000);
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT || 2));
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 20 * 60 * 1000);
const MAX_DURATION_SECONDS = Number(process.env.MAX_DURATION_SECONDS || 3 * 60 * 60);

/* ------------------------------------------------------------------ */
/* Binaries                                                            */
/* ------------------------------------------------------------------ */

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the first usable candidate.
 *
 * Explicit paths are trusted once they exist and are executable: probing them
 * with --version is slow on small instances, where a PyInstaller build such as
 * yt-dlp unpacks itself on first run and can take well over five seconds.
 * Bare command names are probed instead, so a missing system install is not
 * mistaken for a working one.
 */
function resolveExecutable(candidates, probeArgs) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const isPath = candidate.includes('/') || candidate.includes('\\');
    if (isPath) {
      if (isExecutableFile(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, probeArgs, { timeout: 10_000, windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

export const ytdlpBin = resolveExecutable(
  [
    process.env.YTDLP_PATH,
    path.join(ROOT, 'bin', IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'),
    path.join(ROOT, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'),
    'yt-dlp', // resolved through PATH (containers, system installs)
  ],
  ['--version'],
);

export const ffmpegBin = (() => {
  const bundled = (() => {
    try {
      const candidate = require('ffmpeg-static');
      return candidate && fs.existsSync(candidate) ? candidate : null;
    } catch {
      // Not installed in production images: system ffmpeg is used instead.
      return null;
    }
  })();

  return resolveExecutable(
    [
      process.env.FFMPEG_PATH,
      path.join(ROOT, 'bin', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'),
      bundled,
      'ffmpeg', // resolved through PATH
    ],
    ['-version'],
  );
})();

export function binaryReport() {
  return {
    ytDlp: ytdlpBin || null,
    ytDlpExists: ytdlpBin ? fs.existsSync(ytdlpBin) : false,
    ffmpeg: ffmpegBin,
    ready: Boolean(ytdlpBin),
  };
}

function baseArgs() {
  const args = ['--no-warnings', '--no-playlist', '--socket-timeout', '15', '--retries', '3'];
  if (process.env.YTDLP_COOKIES_FILE && fs.existsSync(process.env.YTDLP_COOKIES_FILE)) {
    args.push('--cookies', process.env.YTDLP_COOKIES_FILE);
  }
  if (process.env.YTDLP_EXTRACTOR_ARGS) {
    args.push('--extractor-args', process.env.YTDLP_EXTRACTOR_ARGS);
  }
  if (ffmpegBin) args.push('--ffmpeg-location', ffmpegBin);
  return args;
}

/* ------------------------------------------------------------------ */
/* Error translation                                                   */
/* ------------------------------------------------------------------ */

const ERROR_HINTS = [
  [/sign in to confirm you.?re not a bot/i, 'This site is asking our server to verify itself. Try again in a few minutes, or use a different link.'],
  [/unsupported url|no video formats found|is not a valid url/i, 'That link does not point to a video we can read.'],
  [/private video|video unavailable|this video is unavailable/i, 'This video is private, removed or region blocked.'],
  [/age.?restricted|confirm your age/i, 'Age-restricted videos cannot be converted.'],
  [/members.?only|join this channel/i, 'Members-only videos cannot be converted.'],
  [/live event|is live|premieres in/i, 'Live streams cannot be converted until they finish.'],
  [/requested format is not available/i, 'No audio stream was available for this video.'],
  [/geo.?restricted|not available in your country/i, 'This video is blocked in the server region.'],
  [/timed out|timeout|connection reset|temporary failure/i, 'The source site did not respond in time. Please try again.'],
  [/signature extraction failed|player response/i, 'YouTube changed something on its side. Try a different link or retry shortly.'],
];

function humaniseError(raw) {
  const text = String(raw || '');
  for (const [pattern, message] of ERROR_HINTS) {
    if (pattern.test(text)) return message;
  }
  const firstError = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^error:/i.test(line) || /^ERROR:/i.test(line));
  if (firstError) return firstError.replace(/^error:\s*/i, '').slice(0, 220);
  return 'Conversion failed. Check the link and try again.';
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function sanitiseFileName(title, fallback = 'yp3-audio') {
  const cleaned = String(title || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* yt-dlp invocations                                                  */
/* ------------------------------------------------------------------ */

function run(bin, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error && error.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -2 : code,
        stdout,
        stderr: timedOut ? `${stderr}\nERROR: timed out after ${Math.round(timeout / 1000)}s` : stderr,
      });
    });
  });
}

function pickThumbnail(info) {
  if (typeof info.thumbnail === 'string' && /^https?:\/\//.test(info.thumbnail)) return info.thumbnail;
  if (Array.isArray(info.thumbnails)) {
    const best = [...info.thumbnails]
      .filter((t) => typeof t?.url === 'string' && /^https?:\/\//.test(t.url))
      .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    if (best) return best.url;
  }
  return null;
}

/** Read metadata without downloading media. */
export async function probe(url) {
  if (!ytdlpBin) {
    return { ok: false, error: 'The converter is not installed on this server.' };
  }
  const { code, stdout, stderr } = await run(ytdlpBin, ['-J', '--skip-download', ...baseArgs(), '--', url], {
    timeout: 90_000,
  });
  if (code !== 0) return { ok: false, error: humaniseError(stderr) };

  let info;
  try {
    const start = stdout.indexOf('{');
    info = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    return { ok: false, error: 'Could not read details for this link.' };
  }

  if (info._type === 'playlist' && Array.isArray(info.entries) && info.entries.length) {
    info = info.entries.find(Boolean) || info;
  }
  if (info.is_live || info.live_status === 'is_live') {
    return { ok: false, error: 'Live streams cannot be converted until they finish.' };
  }
  const duration = Number(info.duration) || 0;
  if (duration > MAX_DURATION_SECONDS) {
    return {
      ok: false,
      error: `That video is ${formatDuration(duration)} long. yp3 caps conversions at ${formatDuration(MAX_DURATION_SECONDS)}.`,
    };
  }

  return {
    ok: true,
    meta: {
      title: String(info.title || info.fulltitle || 'Untitled video').slice(0, 200),
      uploader: String(info.uploader || info.channel || info.artist || '').slice(0, 120) || null,
      duration,
      durationLabel: duration ? formatDuration(duration) : null,
      thumbnail: pickThumbnail(info),
      source: String(info.extractor_key || info.extractor || 'video').slice(0, 40),
      webpageUrl: String(info.webpage_url || url),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Job queue                                                           */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const jobs = new Map();
const queue = [];
let active = 0;
let sweepTimer = null;

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    percent: Math.round(job.percent),
    stage: job.stage,
    title: job.meta?.title || null,
    uploader: job.meta?.uploader || null,
    durationLabel: job.meta?.durationLabel || null,
    thumbnail: job.meta?.thumbnail || null,
    source: job.meta?.source || null,
    fileName: job.status === 'ready' ? job.fileName : null,
    sizeBytes: job.status === 'ready' ? job.sizeBytes : null,
    downloadUrl: job.status === 'ready' ? `/api/download/${job.id}` : null,
    error: job.error || null,
  };
}

function setStage(job, status, stage, percent) {
  job.status = status;
  job.stage = stage;
  job.percent = percent;
}

async function executeJob(job) {
  const dir = path.join(WORK_DIR, job.id);
  job.dir = dir;
  await fsp.mkdir(dir, { recursive: true });

  setStage(job, 'working', 'Reading video details', 6);
  const details = await probe(job.url);
  if (!details.ok) {
    job.status = 'error';
    job.error = details.error;
    return;
  }
  job.meta = details.meta;
  job.percent = 12;

  const output = path.join(dir, 'audio.%(ext)s');
  const args = [
    '--newline',
    '-f',
    'bestaudio/best',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '320K',
    '--add-metadata',
    '-o',
    output,
    ...baseArgs(),
    '--',
    job.url,
  ];

  setStage(job, 'working', 'Downloading audio', 14);

  await new Promise((resolve) => {
    const child = spawn(ytdlpBin, args, { windowsHide: true });
    let stderr = '';
    let buffered = '';
    let concluded = false;

    const finish = () => {
      if (concluded) return;
      concluded = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      job.error = 'The conversion took too long and was stopped. Try a shorter video.';
      job.status = 'error';
      child.kill('SIGKILL');
      finish();
    }, JOB_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) {
        const progress = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (progress) {
          const pct = Number(progress[1]);
          setStage(job, 'working', 'Downloading audio', 14 + pct * 0.68);
          continue;
        }
        if (/\[ExtractAudio\]|\[Metadata\]|\[ffmpeg\]/i.test(line)) {
          setStage(job, 'working', 'Encoding 320 kbps MP3', Math.max(job.percent, 84));
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
    });

    child.on('error', (error) => {
      job.status = 'error';
      job.error = `Converter unavailable: ${error.message}`;
      finish();
    });

    child.on('close', (code) => {
      if (job.status === 'error') {
        finish();
        return;
      }
      if (code !== 0) {
        job.status = 'error';
        job.error = humaniseError(stderr);
        finish();
        return;
      }
      setStage(job, 'working', 'Finalising file', 95);
      finish();
    });
  });

  if (job.status === 'error') return;

  let filePath = null;
  try {
    const entries = await fsp.readdir(dir);
    const mp3 = entries.find((name) => name.toLowerCase().endsWith('.mp3'));
    if (mp3) filePath = path.join(dir, mp3);
  } catch {
    /* handled below */
  }
  if (!filePath) {
    job.status = 'error';
    job.error = 'The audio file was not produced. Please try again.';
    return;
  }

  const stat = await fsp.stat(filePath);
  if (stat.size < 1024) {
    job.status = 'error';
    job.error = 'The audio file came back empty. Please try again.';
    return;
  }

  job.filePath = filePath;
  job.fileName = `${sanitiseFileName(job.meta?.title)}.mp3`;
  job.sizeBytes = stat.size;
  job.finishedAt = Date.now();
  setStage(job, 'ready', 'Ready to download', 100);

  // Keep only the finished MP3 inside the job directory.
  try {
    for (const name of await fsp.readdir(dir)) {
      if (path.join(dir, name) !== filePath) await fsp.rm(path.join(dir, name), { force: true, recursive: true });
    }
  } catch {
    /* non-critical */
  }
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    active += 1;
    job.status = 'working';
    job.stage = 'Starting';
    executeJob(job)
      .catch((error) => {
        job.status = 'error';
        job.error = humaniseError(error && error.message);
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const age = now - (job.finishedAt || job.createdAt);
    if (age > JOB_TTL_MS && job.status !== 'queued' && job.status !== 'working') {
      jobs.delete(id);
      if (job.dir) fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Create and enqueue a conversion job. */
export function createJob(url) {
  if (!ytdlpBin) {
    return { ok: false, error: 'The converter is not installed on this server.', status: 503 };
  }
  if (jobs.size > 500) {
    sweep();
  }
  const id = randomUUID();
  const job = {
    id,
    url,
    status: 'queued',
    stage: 'Waiting in queue',
    percent: 2,
    meta: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return { ok: true, job: publicJob(job) };
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export function getJobFile(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'ready' || !job.filePath) return null;
  return { path: job.filePath, fileName: job.fileName, sizeBytes: job.sizeBytes };
}

export function startMaintenance() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, 5 * 60 * 1000);
  sweepTimer.unref?.();
}

export { formatDuration, MAX_DURATION_SECONDS };
