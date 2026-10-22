/* yp3 client: start a conversion, follow its progress, hand over the MP3. */

const form = document.querySelector('#convert-form');
const input = document.querySelector('#video-url');
const convertBtn = document.querySelector('#convert-btn');
const convertLabel = document.querySelector('#convert-btn .btn-label');
const spinner = document.querySelector('#convert-btn .spinner');
const pasteBtn = document.querySelector('#paste-btn');
const formError = document.querySelector('#form-error');
const hint = document.querySelector('#url-hint');
const originalHint = hint.textContent;

const result = document.querySelector('#result');
const resultCard = document.querySelector('#result-card');
const resultStatus = document.querySelector('#result-status');
const resultKicker = document.querySelector('#result-kicker');
const resultTitle = document.querySelector('#result-title');
const resultMeta = document.querySelector('#result-meta');
const resultImage = document.querySelector('#result-image');
const thumbPlaceholder = document.querySelector('#thumb-placeholder');
const progress = document.querySelector('#progress');
const progressFill = document.querySelector('#progress-fill');
const stageLabel = document.querySelector('#stage-label');
const percentLabel = document.querySelector('#percent-label');
const actions = document.querySelector('#result-actions');
const downloadLink = document.querySelector('#download-link');
const resetBtn = document.querySelector('#reset-btn');
const retryBtn = document.querySelector('#retry-btn');

const POLL_INTERVAL = 1000;
const MAX_NETWORK_FAILURES = 5;

let pollTimer = null;
let networkFailures = 0;
let currentJobId = null;
let busy = false;
let lastThumbnail = null;

/* ---------------------------------------------------------------- */
/* Helpers                                                           */
/* ---------------------------------------------------------------- */

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

function flashHint(message) {
  hint.textContent = message;
  window.clearTimeout(flashHint.timer);
  flashHint.timer = window.setTimeout(() => {
    hint.textContent = originalHint;
  }, 4000);
}

function setBusy(next) {
  busy = next;
  convertBtn.disabled = next;
  convertBtn.dataset.busy = next ? 'true' : 'false';
  convertLabel.textContent = next ? 'Converting…' : 'Convert to MP3';
  spinner.hidden = !next;
  input.readOnly = next;
}

function stopPolling() {
  window.clearTimeout(pollTimer);
  pollTimer = null;
}

function setProgress(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  progressFill.style.width = `${value}%`;
  progress.setAttribute('aria-valuenow', String(Math.round(value)));
  percentLabel.textContent = `${Math.round(value)}%`;
}

function setThumbnail(url) {
  if (typeof url === 'string' && /^https:\/\//.test(url)) {
    resultImage.src = url;
    resultImage.alt = '';
    resultImage.hidden = false;
    thumbPlaceholder.hidden = true;
    resultImage.addEventListener(
      'error',
      () => {
        resultImage.hidden = true;
        thumbPlaceholder.hidden = false;
      },
      { once: true },
    );
  } else {
    resultImage.removeAttribute('src');
    resultImage.hidden = true;
    thumbPlaceholder.hidden = false;
  }
}

function resetResultView() {
  result.hidden = false;
  resultCard.dataset.state = 'working';
  resultKicker.textContent = 'Converting';
  resultTitle.textContent = 'Reading video details…';
  resultMeta.textContent = '';
  resultStatus.textContent = 'Conversion started.';
  lastThumbnail = null;
  setThumbnail(null);
  setProgress(2);
  stageLabel.textContent = 'Starting';
  actions.hidden = true;
  retryBtn.hidden = true;
  downloadLink.removeAttribute('href');
  downloadLink.removeAttribute('download');
}

function finishUi() {
  stopPolling();
  setBusy(false);
  currentJobId = null;
}

/* ---------------------------------------------------------------- */
/* Rendering                                                         */
/* ---------------------------------------------------------------- */

function render(job) {
  if (!job || typeof job !== 'object') return;

  if (job.title) resultTitle.textContent = job.title;
  const metaParts = [job.uploader, job.durationLabel, job.source].filter(Boolean);
  if (metaParts.length) resultMeta.textContent = metaParts.join(' · ');

  if (job.thumbnail && job.thumbnail !== lastThumbnail) {
    setThumbnail(job.thumbnail);
    lastThumbnail = job.thumbnail;
  }

  if (job.status === 'ready') {
    resultCard.dataset.state = 'ready';
    resultKicker.textContent = 'Ready to download';
    setProgress(100);
    actions.hidden = false;
    retryBtn.hidden = true;
    downloadLink.href = job.downloadUrl || '#';
    downloadLink.setAttribute('download', job.fileName || 'yp3-audio.mp3');
    const parts = [job.uploader, job.durationLabel, formatBytes(job.sizeBytes)].filter(Boolean);
    resultMeta.textContent = parts.join(' · ');
    resultStatus.textContent = `Conversion finished. ${job.fileName || 'Your MP3'} is ready to download.`;
    finishUi();
    return;
  }

  if (job.status === 'error') {
    resultCard.dataset.state = 'error';
    resultKicker.textContent = 'Conversion failed';
    setProgress(0);
    actions.hidden = true;
    retryBtn.hidden = false;
    resultTitle.textContent = job.title || 'That link could not be converted';
    resultMeta.textContent = job.error || 'Something went wrong. Please try another link.';
    resultStatus.textContent = 'Conversion failed.';
    finishUi();
    return;
  }

  resultCard.dataset.state = 'working';
  resultKicker.textContent = 'Converting';
  setProgress(job.percent || 2);
  stageLabel.textContent = job.stage || 'Working';
  resultStatus.textContent = `Converting: ${Math.round(job.percent || 0)} percent.`;
}

/* ---------------------------------------------------------------- */
/* Requests                                                          */
/* ---------------------------------------------------------------- */

async function poll(jobId) {
  if (!jobId) return;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));

    if (response.status === 404) {
      networkFailures = 0;
      render({
        status: 'error',
        error: data.error || 'This conversion expired. Please start again.',
      });
      return;
    }
    if (!response.ok) {
      if (response.status === 429) {
        pollTimer = window.setTimeout(() => poll(jobId), 3000);
        return;
      }
      render({ status: 'error', error: data.error || 'The server rejected that request.' });
      return;
    }

    networkFailures = 0;
    render(data.job);
    if (data.job && (data.job.status === 'ready' || data.job.status === 'error')) return;

    pollTimer = window.setTimeout(() => poll(jobId), POLL_INTERVAL);
  } catch (error) {
    networkFailures += 1;
    if (networkFailures >= MAX_NETWORK_FAILURES) {
      render({
        status: 'error',
        error: 'Lost contact with the server. Check your connection and try again.',
      });
      return;
    }
    pollTimer = window.setTimeout(() => poll(jobId), POLL_INTERVAL * 1.6);
  }
}

async function startConversion(url) {
  showError('');
  resetResultView();
  setBusy(true);
  networkFailures = 0;
  stopPolling();

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setBusy(false);
      result.hidden = true;
      showError(data.error || 'Could not start that conversion. Try again in a moment.');
      return;
    }

    currentJobId = data.job?.id || null;
    render(data.job || { status: 'working', percent: 3, stage: 'Queued' });
    poll(currentJobId);
  } catch (error) {
    setBusy(false);
    result.hidden = true;
    showError('Could not reach the converter. Check your connection and try again.');
  }
}

/* ---------------------------------------------------------------- */
/* Events                                                            */
/* ---------------------------------------------------------------- */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;

  const value = input.value.trim();
  if (!value) {
    showError('Paste a video link first.');
    input.focus();
    return;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    showError('That does not look like a link. Include the full address, starting with https://');
    input.focus();
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    showError('Only http and https links are supported.');
    return;
  }

  startConversion(value);
});

pasteBtn.addEventListener('click', async () => {
  if (busy) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      input.value = text.trim();
      showError('');
      input.focus();
      return;
    }
    flashHint('Your clipboard is empty. Copy a video link first.');
  } catch {
    input.focus();
    flashHint('Clipboard access is blocked here — paste with Ctrl+V (or ⌘V).');
  }
});

resetBtn.addEventListener('click', () => {
  stopPolling();
  setBusy(false);
  result.hidden = true;
  showError('');
  input.value = '';
  input.focus();
});

retryBtn.addEventListener('click', () => {
  result.hidden = true;
  showError('');
  input.focus();
  input.select();
});

window.addEventListener('beforeunload', stopPolling);

const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());
