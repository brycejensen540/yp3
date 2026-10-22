#!/usr/bin/env node
/**
 * Download the standalone yt-dlp binary into ./bin.
 *
 * The standalone builds need no Python, which keeps local setup and container
 * images small. Run with: npm run setup:ytdlp
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');

const TARGETS = {
  win32: { asset: 'yt-dlp.exe', file: 'yt-dlp.exe' },
  darwin: { asset: 'yt-dlp_macos', file: 'yt-dlp' },
  linux: { asset: 'yt-dlp_linux', file: 'yt-dlp' },
};

const target = TARGETS[process.platform] || { asset: 'yt-dlp', file: 'yt-dlp' };
const destination = path.join(BIN_DIR, target.file);

async function download(url, to) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(to, buffer);
  if (process.platform !== 'win32') await fsp.chmod(to, 0o755);
}

async function main() {
  await fsp.mkdir(BIN_DIR, { recursive: true });

  if (fs.existsSync(destination)) {
    console.log(`yt-dlp already present at ${destination}`);
    return;
  }

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${target.asset}`;
  console.log(`Fetching ${url}`);
  await download(url, destination);
  const { size } = await fsp.stat(destination);
  console.log(`Saved ${destination} (${(size / 1_048_576).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error(`Could not install yt-dlp: ${error.message}`);
  process.exit(1);
});
