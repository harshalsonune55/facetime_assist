'use strict';

const $ = (id) => document.getElementById(id);
const api = window.clue;

const el = {
  app: $('app'),
  dragHandle: $('dragHandle'),
  dot: $('dot'),
  input: $('input'),
  screenBtn: $('screenBtn'),
  listenBtn: $('listenBtn'),
  listenLabel: $('listenLabel'),
  autoBtn: $('autoBtn'),
  timer: $('timer'),
  settingsBtn: $('settingsBtn'),
  hideBtn: $('hideBtn'),
  panel: $('panel'),
  answer: $('answer'),
  status: $('status'),
  heard: $('heard'),
  stopBtn: $('stopBtn'),
  copyAllBtn: $('copyAllBtn'),
  clearBtn: $('clearBtn'),
  settings: $('settings'),
};

const state = {
  streaming: false,
  answer: '',
  listening: false,
  auto: false,
  listenStart: 0,
  settingsOpen: false,
};

/* ------------------------------------------------------- window plumbing */

// Report our real height so the frameless window hugs the content.
const syncHeight = () => api.setHeight(Math.ceil(el.app.getBoundingClientRect().height) + 2);
new ResizeObserver(syncHeight).observe(el.app);

// The window is click-through except where there is actually something to click.
let interactive = false;
const setInteractive = (v) => {
  if (v === interactive) return;
  interactive = v;
  api.setMouseInteractive(v);
};
document.addEventListener('mousemove', (e) => {
  if (dragging) return; // the grip owns the mouse until it is let go
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  setInteractive(Boolean(hit && hit.closest('[data-hit]')));
});
document.addEventListener('mouseleave', () => {
  if (!dragging) setInteractive(false);
});

// The grip icon drags the whole window. Screen coordinates are the only stable
// reference here: the window chases the cursor, so page coordinates barely move.
let dragging = false;
let dragX = 0;
let dragY = 0;
// Cursor deltas are fractional on a scaled display but the window only moves in
// whole pixels, so the leftover is carried into the next frame instead of lost.
let accX = 0;
let accY = 0;
let dragPending = false;

el.dragHandle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragX = e.screenX;
  dragY = e.screenY;
  accX = 0;
  accY = 0;
  el.dragHandle.classList.add('dragging');
  el.dragHandle.setPointerCapture(e.pointerId);
  setInteractive(true);
  e.preventDefault();
});

el.dragHandle.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  accX += e.screenX - dragX;
  accY += e.screenY - dragY;
  dragX = e.screenX;
  dragY = e.screenY;
  // Coalesce to one move per frame so a fast drag cannot flood the main process.
  if (dragPending) return;
  dragPending = true;
  requestAnimationFrame(() => {
    dragPending = false;
    if (!dragging) return;
    const dx = Math.round(accX);
    const dy = Math.round(accY);
    if (!dx && !dy) return;
    accX -= dx;
    accY -= dy;
    api.move(dx, dy);
  });
});

const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  dragPending = false;
  accX = 0;
  accY = 0;
  el.dragHandle.classList.remove('dragging');
  if (e && e.pointerId !== undefined && el.dragHandle.hasPointerCapture(e.pointerId)) {
    el.dragHandle.releasePointerCapture(e.pointerId);
  }
};
el.dragHandle.addEventListener('pointerup', endDrag);
el.dragHandle.addEventListener('pointercancel', endDrag);

/* ------------------------------------------------------------- rendering */

let frame = null;
function paint() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const nearBottom =
      el.answer.scrollHeight - el.answer.scrollTop - el.answer.clientHeight < 60;
    el.answer.innerHTML = window.renderMarkdown(state.answer);
    if (nearBottom) el.answer.scrollTop = el.answer.scrollHeight;
  });
}

function showPanel(show) {
  el.panel.classList.toggle('hidden', !show);
  syncHeight();
}

function setStatus(text, isError) {
  el.status.textContent = text || '';
  el.status.classList.toggle('error', Boolean(isError));
  el.status.classList.toggle('hidden', !text);
}

function setBusy(busy) {
  state.streaming = busy;
  el.stopBtn.classList.toggle('hidden', !busy);
  el.dot.classList.toggle('busy', busy);
  if (!busy && state.listening) el.dot.classList.add('live');
}

/* ------------------------------------------------------------------ ask */

async function ask(question, withScreenshot) {
  if (state.streaming) api.stopAsk();
  state.answer = '';
  el.answer.innerHTML = '';
  showPanel(true);
  setStatus(withScreenshot ? 'Reading your screen…' : 'Thinking…');
  setBusy(true);
  el.input.value = '';
  await api.ask(question, withScreenshot);
}

api.onDelta((chunk) => {
  if (!state.streaming) return;
  setStatus('');
  state.answer += chunk;
  paint();
});

api.onDone(({ aborted }) => {
  setBusy(false);
  if (aborted && !state.answer) setStatus('Stopped.');
  else if (!state.answer) setStatus('No answer came back. Try again.');
  syncHeight();
});

// Auto mode: the main process heard a question and is already answering it.
api.onAuto(() => {
  state.answer = '';
  el.answer.innerHTML = '';
  showPanel(true);
  setStatus('Heard a question — answering…');
  setBusy(true);
});

api.onError((message) => {
  setBusy(false);
  setStatus(message, true);
  showPanel(true);
});

/* --------------------------------------------------------------- listen */

let audio = null;

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

let tick = null;
function updateListenUi() {
  el.listenBtn.classList.toggle('on', state.listening);
  el.listenLabel.textContent = state.listening ? 'Listening' : 'Listen';
  el.timer.classList.toggle('hidden', !state.listening);
  el.dot.classList.toggle('live', state.listening && !state.streaming);
  clearInterval(tick);
  if (state.listening) {
    tick = setInterval(() => {
      el.timer.textContent = fmtTime(Date.now() - state.listenStart);
    }, 500);
    el.timer.textContent = '00:00';
  }
}

async function startListening() {
  const cfg = await api.getState();
  if (!cfg.hasSttKey) {
    showPanel(true);
    setStatus('Listen mode needs a transcription API key. Press ⌘, to add one.', true);
    return;
  }

  let mic = null;
  let display = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    showPanel(true);
    setStatus('Microphone access was refused. Enable it in System Settings › Privacy › Microphone.', true);
    return;
  }

  // System audio (the other side of the call) via Electron's loopback capture.
  // Optional: if it fails we still have the microphone.
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    display = null;
  }

  const ctx = new AudioContext();
  const mixer = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(mic).connect(mixer);

  let systemHeard = false;
  if (display && display.getAudioTracks().length) {
    ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(mixer);
    systemHeard = true;
  }
  // We only asked for video to unlock loopback audio; we never look at it.
  if (display) display.getVideoTracks().forEach((t) => t.stop());

  const meter = ctx.createAnalyser();
  meter.fftSize = 512;
  ctx.createMediaStreamSource(mixer.stream).connect(meter);

  audio = { ctx, mixer, meter, mic, display, recorder: null, stopTimer: null, peak: 0, alive: true };
  state.listening = true;
  state.listenStart = Date.now();
  updateListenUi();
  el.heard.textContent = systemHeard ? 'mic + system audio' : 'mic only';

  const buf = new Uint8Array(meter.fftSize);
  audio.levelTimer = setInterval(() => {
    meter.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
    audio.peak = Math.max(audio.peak, peak);
  }, 200);

  cycle();
}

// One MediaRecorder per clip: restarting it makes every blob a complete,
// standalone webm file that a transcription endpoint will accept.
const CLIP_MS = 7000;
const SILENCE = 0.02;

function cycle() {
  if (!audio || !audio.alive) return;
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  const chunks = [];
  const rec = new MediaRecorder(audio.mixer.stream, { mimeType, audioBitsPerSecond: 32000 });
  audio.recorder = rec;
  audio.peak = 0;

  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    const loud = audio && audio.peak > SILENCE;
    const alive = audio && audio.alive;
    if (loud && chunks.length) {
      const blob = new Blob(chunks, { type: mimeType });
      try {
        const text = await api.sendAudio(await blob.arrayBuffer(), mimeType);
        if (text) el.heard.textContent = text.slice(-120);
      } catch {
        /* main process already reported it */
      }
    }
    if (alive) cycle();
  };

  rec.start();
  audio.stopTimer = setTimeout(() => rec.state !== 'inactive' && rec.stop(), CLIP_MS);
}

function stopListening() {
  if (!audio) return;
  audio.alive = false;
  clearTimeout(audio.stopTimer);
  clearInterval(audio.levelTimer);
  try {
    if (audio.recorder && audio.recorder.state !== 'inactive') audio.recorder.stop();
  } catch {
    /* already stopped */
  }
  audio.mic.getTracks().forEach((t) => t.stop());
  if (audio.display) audio.display.getTracks().forEach((t) => t.stop());
  audio.ctx.close();
  audio = null;
  state.listening = false;
  updateListenUi();
}

const toggleListen = () => (state.listening ? stopListening() : startListening());

api.onTranscriptLine((line) => {
  el.heard.textContent = line.slice(-120);
});

api.onListenError((message) => {
  showPanel(true);
  setStatus(message, true);
});

/* ------------------------------------------------------------- settings */

const S = {
  openaiKey: $('openaiKey'),
  sttKey: $('sttKey'),
  sttBaseUrl: $('sttBaseUrl'),
  sttModel: $('sttModel'),
  model: $('model'),
  effort: $('effort'),
  profile: $('profile'),
  openaiState: $('openaiState'),
  sttState: $('sttState'),
  permission: $('permission'),
  saved: $('saved'),
};

const SHORTCUT_KEYS = ['toggle', 'ask', 'screenshotAsk', 'listen', 'reset'];

async function loadSettings() {
  const cfg = await api.getState();
  S.model.value = cfg.model;
  S.effort.value = cfg.effort;
  S.profile.value = cfg.profile || '';
  S.sttBaseUrl.value = cfg.sttBaseUrl;
  S.sttModel.value = cfg.sttModel;
  S.openaiState.textContent = cfg.hasOpenaiKey ? '· saved' : '';
  S.sttState.textContent = cfg.hasSttKey ? '· saved' : '';
  S.openaiKey.placeholder = cfg.hasOpenaiKey
    ? '•••••••••••• (leave blank to keep)'
    : 'sk-proj-...';
  S.sttKey.placeholder = cfg.hasSttKey
    ? '•••••••••••• (leave blank to keep)'
    : 'blank = use the key for the endpoint above';
  for (const key of SHORTCUT_KEYS) $(`sc-${key}`).value = cfg.shortcuts[key] || '';

  const needsPermission = cfg.platform === 'darwin' && cfg.screenPermission !== 'granted';
  S.permission.classList.toggle('hidden', !needsPermission);
  S.permission.firstElementChild.textContent =
    'Screen Recording is off — Clue cannot see your screen yet.';

  // No OpenAI key: there is nothing to ask with.
  if (!cfg.hasActiveKey && !state.settingsOpen) openSettings();
  return cfg;
}

async function saveSettings() {
  const patch = {
    effort: S.effort.value,
    profile: S.profile.value,
    sttBaseUrl: S.sttBaseUrl.value.trim(),
    sttModel: S.sttModel.value.trim(),
    shortcuts: Object.fromEntries(SHORTCUT_KEYS.map((k) => [k, $(`sc-${k}`).value.trim()])),
  };
  if (S.openaiKey.value.trim()) patch.openaiKey = S.openaiKey.value.trim();
  if (S.sttKey.value.trim()) patch.sttKey = S.sttKey.value.trim();

  await api.saveSettings(patch);
  S.openaiKey.value = '';
  S.sttKey.value = '';
  await loadSettings();
  S.saved.textContent = 'Saved';
  setTimeout(() => (S.saved.textContent = ''), 1600);
}

function openSettings() {
  state.settingsOpen = true;
  el.settings.classList.remove('hidden');
  showPanel(false);
  loadSettings();
  syncHeight();
}

function closeSettings() {
  state.settingsOpen = false;
  el.settings.classList.add('hidden');
  syncHeight();
}

const toggleSettings = () => (state.settingsOpen ? closeSettings() : openSettings());

/* -------------------------------------------------------------- wiring */

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = el.input.value.trim();
    if (q) ask(q, e.shiftKey || e.metaKey);
  }
});

el.screenBtn.addEventListener('click', () => ask(el.input.value.trim(), true));
el.listenBtn.addEventListener('click', toggleListen);
el.autoBtn.addEventListener('click', () => {
  state.auto = !state.auto;
  api.setAuto(state.auto);
  el.autoBtn.classList.toggle('auto-on', state.auto);
  if (state.auto && !state.listening) {
    showPanel(true);
    setStatus('Auto is on — turn on Listen (⌘L) so Clue can hear the questions.');
  }
});
el.settingsBtn.addEventListener('click', toggleSettings);
el.hideBtn.addEventListener('click', () => api.hide());
el.stopBtn.addEventListener('click', () => api.stopAsk());
el.clearBtn.addEventListener('click', () => {
  api.resetSession();
});
el.copyAllBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(state.answer);
  el.copyAllBtn.textContent = 'copied';
  setTimeout(() => (el.copyAllBtn.textContent = 'copy'), 1200);
});

$('closeSettings').addEventListener('click', closeSettings);
$('saveBtn').addEventListener('click', saveSettings);
$('quitBtn').addEventListener('click', () => api.quit());
$('permBtn').addEventListener('click', () => api.openScreenSettings());

// Code-block copy buttons and links inside streamed markdown.
el.answer.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const code = copy.closest('.code-block').querySelector('code');
    navigator.clipboard.writeText(code.textContent);
    copy.textContent = 'copied';
    setTimeout(() => (copy.textContent = 'copy'), 1200);
    return;
  }
  const link = e.target.closest('[data-link]');
  if (link) {
    e.preventDefault();
    api.openExternal(link.getAttribute('href'));
  }
});

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (state.streaming) api.stopAsk();
    else if (state.settingsOpen) closeSettings();
    else api.hide();
    return;
  }
  if (meta && e.key === ',') {
    e.preventDefault();
    toggleSettings();
  }
  if (meta && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    el.input.focus();
    el.input.select();
  }
  if (meta && e.key === 'Enter' && document.activeElement !== el.input) {
    e.preventDefault();
    ask(el.input.value.trim(), true);
  }
});

/* ------------------------------------------------- global shortcut relay */

api.onFocusInput(() => {
  closeSettings();
  el.input.focus();
  el.input.select();
});

api.onQuickAsk(() => {
  closeSettings();
  ask(el.input.value.trim(), true);
});

api.onToggleListen(toggleListen);

api.onReset(() => {
  state.answer = '';
  el.answer.innerHTML = '';
  el.heard.textContent = state.listening ? 'listening…' : '';
  setStatus('');
  showPanel(false);
});

loadSettings().then(syncHeight);
