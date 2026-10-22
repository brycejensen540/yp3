# yp3

**Video links in. Clean MP3s out.**

yp3 is a small, self-hostable web app that turns a public video link into a tagged,
constant 320 kbps MP3 you can download. It uses [yt-dlp](https://github.com/yt-dlp/yt-dlp)
to fetch the best audio stream a site offers and [ffmpeg](https://ffmpeg.org) to encode it.

![Node](https://img.shields.io/badge/node-%3E%3D20-0a7fa8)
![License](https://img.shields.io/badge/license-MIT-e9661c)

## What it does

- Accepts links from YouTube, Vimeo, SoundCloud, TikTok, X, Facebook, Instagram,
  Dailymotion, Bandcamp, Twitch, Reddit, Archive.org and other public sites yt-dlp supports.
- Downloads the highest-quality **audio-only** stream, never a screen rip.
- Encodes **MP3 at a constant 320 kbps**, preserving the source sample rate, with title and artist tags embedded.
- Streams progress to the browser and serves the finished file as a download.
- Deletes every artefact after 45 minutes.

## Honest note on "lossless"

MP3 is a lossy format, so a lossless MP3 cannot exist. yp3 encodes at 320 kbps CBR —
the highest bitrate MP3 supports — from the best source stream available. If the source
upload is itself low quality, the output matches that source and nothing more.
The interface says this plainly instead of promising "lossless" audio.

## Requirements

- Node.js 20 or newer
- `yt-dlp` (the setup script fetches the standalone build, no Python needed)
- `ffmpeg` — either on `PATH`, the bundled `ffmpeg-static` dev dependency, or `FFMPEG_PATH`

## Run locally

```bash
git clone https://github.com/brycejensen540/yp3.git
cd yp3
npm install
npm run setup:ytdlp   # downloads ./bin/yt-dlp (or yt-dlp.exe on Windows)
npm run dev           # http://localhost:3000
```

Open <http://localhost:3000> and paste a link. `npm start` runs the same server without
watch mode.

## Configuration

Every setting is optional; see [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port (`10000` in the container) |
| `MAX_CONCURRENT` | `2` | Conversions running at once |
| `MAX_DURATION_SECONDS` | `10800` | Reject longer videos (3 hours) |
| `JOB_TTL_MS` | `2700000` | Time before files are purged (45 min) |
| `JOB_TIMEOUT_MS` | `1200000` | Hard limit per job (20 min) |
| `WORK_DIR` | `./tmp` | Temporary audio directory |
| `YTDLP_PATH` / `FFMPEG_PATH` | auto-detected | Explicit binary paths |
| `YTDLP_COOKIES_FILE` | – | Netscape cookie file for rate-limited sources |
| `YTDLP_EXTRACTOR_ARGS` | – | Extra yt-dlp extractor arguments |

## API

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/jobs` | `{ "url": "https://..." }` → `202 { job }` |
| `GET` | `/api/jobs/:id` | Job status, progress, metadata |
| `GET` | `/api/download/:id` | The finished MP3 as an attachment |
| `GET` | `/api/sites` | Supported source labels |
| `GET` | `/healthz` | Liveness plus converter availability |

Jobs move through `queued` → `working` → `ready` (or `error`). Progress is reported as
`percent` plus a human-readable `stage`.

## Deploy

### Render (one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/brycejensen540/yp3)

The [`render.yaml`](render.yaml) blueprint creates a Docker web service, points Render at
`/healthz`, and keeps a single instance. On the free plan the service sleeps after 15
minutes of inactivity, so the first request after a quiet period takes ~30 seconds to
wake. Use a paid instance for always-on behaviour.

### Any Docker host

```bash
docker build -t yp3 .
docker run -p 10000:10000 -e PORT=10000 yp3
```

The image installs `ffmpeg` from Debian, downloads the latest standalone `yt-dlp`, and
runs as the unprivileged `node` user.

### Notes for hosted deployments

YouTube frequently challenges requests coming from datacenter IPs with
*"Sign in to confirm you're not a bot"*. The block is tied to the server's IP, so changing
player clients or impersonation does not clear it; supplying cookies does. Render secret
files are the simplest route, and the blueprint already points `YTDLP_COOKIES_FILE` at
`/etc/secrets/cookies.txt`:

1. Export cookies for `youtube.com` in Netscape format from a signed-in browser
   (a throwaway account is wise — cookies grant access to it).
2. In Render, open the service → **Environment** → **Secret Files** → **Add file**, name it
   `cookies.txt`, and paste the contents.
3. Save; the service restarts and picks the file up. The app ignores the setting when the
   file is absent.

Cookies expire (usually after a few weeks), so treat this as a maintenance task rather than
a one-off. A residential proxy solves it without cookies, at a cost. Keeping the image
recent also matters, since yt-dlp ships fixes for YouTube changes almost weekly.

## Security posture

- URL allowlist for supported sites, plus rejection of credentials, non-HTTP schemes,
  loopback and private-range hosts (no SSRF into the host network).
- Rate limiting on job creation and on reads.
- No user accounts, no uploads, no database; only temporary files under `WORK_DIR`.
- Strict CSP, `nosniff`, `no-referrer`-style policy, frame denial, HSTS in production.
- Downloads are served with `no-store` and an explicit `Content-Disposition`.

## Project layout

```
server.js          Express app, routes, security headers, rate limits
lib/converter.js   Binary resolution, yt-dlp probing, queue, encoding, cleanup
lib/urls.js        URL validation and site allowlist
public/            Landing page, converter UI, styles, client script
scripts/           yt-dlp installer
Dockerfile         Production image (ffmpeg + yt-dlp + app)
render.yaml        Render blueprint
```

## Legal

Download only content you own or have permission to use. Respect each source site's terms
of service and the rights of creators. yp3 is a tool, not a licence.

MIT licensed.
