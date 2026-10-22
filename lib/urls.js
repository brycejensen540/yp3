/**
 * URL validation for yp3.
 *
 * Only well-known public media sites are accepted. An allowlist (rather than a
 * blocklist) keeps the server from being pointed at internal hosts, cloud
 * metadata endpoints or arbitrary files, and gives users a clear error when a
 * link is not something we can handle.
 */

const SUPPORTED_HOSTS = [
  // Video
  'youtube.com',
  'youtu.be',
  'music.youtube.com',
  'm.youtube.com',
  'vimeo.com',
  'dailymotion.com',
  'twitch.tv',
  'ted.com',
  'bitchute.com',
  'rumble.com',
  'odysee.com',
  'nicovideo.jp',
  'bilibili.com',
  'streamable.com',
  'archive.org',
  // Short form / social
  'tiktok.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'fb.watch',
  'instagram.com',
  'reddit.com',
  'v.redd.it',
  'linkedin.com',
  // Audio-forward
  'soundcloud.com',
  'bandcamp.com',
  'mixcloud.com',
  'audiomack.com',
  'podcasts.apple.com',
  'open.spotify.com',
];

const SUPPORTED_LABELS = [
  'YouTube',
  'Vimeo',
  'SoundCloud',
  'TikTok',
  'X',
  'Facebook',
  'Instagram',
  'Dailymotion',
  'Bandcamp',
  'Twitch',
  'Reddit',
  'Archive.org',
];

/** Host matches the allowlist exactly or as a subdomain of a listed host. */
function isAllowedHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return SUPPORTED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Reject anything that is not a plain public http(s) URL. */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return true;
  }
  // IPv4 literals in private / loopback / link-local / CGNAT ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // IPv6 literals (bracketed hosts arrive without brackets from the URL API).
  if (host.includes(':')) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  }
  return false;
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function validateVideoUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'Paste a video link to get started.' };
  }
  const raw = input.trim();
  if (raw.length > 2048) {
    return { ok: false, error: 'That link is too long to process.' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'That does not look like a valid link. Include https:// at the start.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Only http and https links are supported.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Links with embedded credentials are not accepted.' };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, error: 'Private and local addresses are not accepted.' };
  }
  if (!isAllowedHost(parsed.hostname)) {
    return {
      ok: false,
      error: `yp3 does not support ${parsed.hostname} yet. Try YouTube, Vimeo, SoundCloud or another listed site.`,
    };
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

export { SUPPORTED_LABELS };
