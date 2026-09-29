'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

// Clue talks to exactly one model on one provider.
const MODEL = 'gpt-5.6-sol';
const EFFORT = 'high';

const DEFAULTS = {
  openaiKey: '',
  // Optional. Only needed for Listen mode (speech -> text). Any OpenAI-compatible
  // /v1/audio/transcriptions endpoint works (OpenAI, a local whisper server, ...).
  sttKey: '',
  sttBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'gpt-4o-transcribe',
  model: MODEL,
  effort: EFFORT,
  profile: '',
  shortcuts: {
    toggle: 'CommandOrControl+\\',
    ask: 'CommandOrControl+Return',
    screenshotAsk: 'CommandOrControl+Shift+Return',
    listen: 'CommandOrControl+L',
    reset: 'CommandOrControl+Shift+R',
  },
};

// Secrets are encrypted with the OS keychain when it is available, so the config
// file on disk never holds a plaintext key.
const SECRETS = ['openaiKey', 'sttKey'];

// Keys from the days when Clue spoke to other providers. Dropped on load and on
// save so a stale key cannot linger in config.json.
const RETIRED = ['anthropicKey', 'groqKey'];

let cache = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function decode(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value || '';
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  } catch {
    return '';
  }
}

function encode(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) return value;
  return 'enc:' + safeStorage.encryptString(value).toString('base64');
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    stored = {};
  }
  cache = {
    ...DEFAULTS,
    ...stored,
    shortcuts: { ...DEFAULTS.shortcuts, ...(stored.shortcuts || {}) },
  };
  for (const key of RETIRED) delete cache[key];
  for (const key of SECRETS) cache[key] = decode(cache[key]);
  // Environment wins, so `OPENAI_API_KEY=... npm start` just works.
  if (process.env.OPENAI_API_KEY) cache.openaiKey = process.env.OPENAI_API_KEY;
  // Listen mode falls back to the chat key when the transcription endpoint is on
  // OpenAI too - same account, same key, one less field to fill in.
  if (!cache.sttKey && /api\.openai\.com/.test(cache.sttBaseUrl)) cache.sttKey = cache.openaiKey;
  // There is only one model and effort level. Leftovers from older builds
  // would otherwise keep sending requests with the previous configuration.
  cache.model = MODEL;
  cache.effort = EFFORT;
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  if (patch.shortcuts) next.shortcuts = { ...load().shortcuts, ...patch.shortcuts };
  next.model = MODEL;
  next.effort = EFFORT;
  cache = next;

  const onDisk = { ...next };
  for (const key of RETIRED) delete onDisk[key];
  for (const key of SECRETS) onDisk[key] = encode(next[key]);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  cache = null; // re-derive the env/stt fallbacks on the next load
  return load();
}

function activeKey(cfg = load()) {
  return cfg.openaiKey;
}

// What the renderer is allowed to see: presence of keys, never the keys.
function publicView() {
  const c = load();
  return {
    hasOpenaiKey: Boolean(c.openaiKey),
    hasSttKey: Boolean(c.sttKey),
    hasActiveKey: Boolean(activeKey(c)),
    sttBaseUrl: c.sttBaseUrl,
    sttModel: c.sttModel,
    model: c.model,
    effort: c.effort,
    profile: c.profile,
    shortcuts: c.shortcuts,
  };
}

module.exports = { load, save, publicView, configPath, activeKey, MODEL, EFFORT, DEFAULTS };
