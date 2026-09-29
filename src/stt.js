'use strict';

const config = require('./config');

/**
 * Sends one short audio clip to an OpenAI-compatible /audio/transcriptions
 * endpoint. Works with OpenAI or a local whisper server - whatever
 * base URL and model the user configured.
 */
async function transcribe(buffer, mimeType = 'audio/webm') {
  const cfg = config.load();
  if (!cfg.sttKey) {
    const err = new Error('No transcription key set. Add one in settings (⌘,) to use Listen mode.');
    err.code = 'NO_STT_KEY';
    throw err;
  }

  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), `clip.${ext}`);
  form.append('model', cfg.sttModel);
  form.append('response_format', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${cfg.sttBaseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.sttKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json.text || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { transcribe };
