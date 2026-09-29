'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  session,
  desktopCapturer,
} = require('electron');

// Packaged, the app is called "Clue"; from `npm start` it is "clue" - which
// would be two different config folders, and a key that vanishes once you build
// a .app. Pin it so both find the same settings.
app.setPath('userData', path.join(app.getPath('appData'), 'clue'));

const config = require('./config');
const { Brain } = require('./llm');
const { grabScreen, screenPermission } = require('./capture');
const { transcribe } = require('./stt');

const WIDTH = 780;
const BAR_HEIGHT = 56;

let win = null;
const brain = new Brain();

// Rolling transcript of the live conversation, newest last.
const transcript = [];
const TRANSCRIPT_CHARS = 6000;

function transcriptText() {
  let out = '';
  for (let i = transcript.length - 1; i >= 0; i--) {
    const line = transcript[i] + '\n';
    if (out.length + line.length > TRANSCRIPT_CHARS) break;
    out = line + out;
  }
  return out.trim();
}

/* ---------------------------------------------------------------- window */

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;

  win = new BrowserWindow({
    width: WIDTH,
    height: BAR_HEIGHT,
    x: Math.round(x + (width - WIDTH) / 2),
    y: y + 24,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    // Rounded corners are drawn by the page, so the frame must not paint a background.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // The three lines that make it "invisible": excluded from screen capture and
  // screen sharing, floating above full-screen apps, present on every Space.
  win.setContentProtection(true);
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindows: true });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Start click-through; the renderer re-enables the mouse over real controls.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.on('closed', () => {
    win = null;
  });

  // Surface renderer warnings and errors in the terminal - a transparent
  // overlay gives no other clue that its page broke.
  win.webContents.on('console-message', (...args) => {
    const e = typeof args[0] === 'object' && args[0] && 'message' in args[0] ? args[0] : null;
    const level = e ? e.level : args[1];
    const message = e ? e.message : args[2];
    if (level === 'error' || level === 'warning' || level === 2 || level === 3) {
      console.log(`[renderer:${level}] ${message}`);
    }
  });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver', 1);
  }
}

function showAndFocus() {
  if (!win) createWindow();
  if (!win.isVisible()) win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.focus();
}

function nudge(dx, dy) {
  if (!win || win.isDestroyed()) return;
  // setPosition throws on a fractional coordinate, and a drag on a scaled
  // display delivers fractional deltas - so round before it ever gets there.
  const mx = Math.round(dx);
  const my = Math.round(dy);
  if (!Number.isFinite(mx) || !Number.isFinite(my) || (!mx && !my)) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + mx, y + my, false);
}

/* ------------------------------------------------------------- shortcuts */

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const keys = config.load().shortcuts;

  const bind = (accel, fn) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) {
        console.warn(`[clue] shortcut in use by another app: ${accel}`);
      }
    } catch (err) {
      console.warn(`[clue] bad shortcut ${accel}: ${err.message}`);
    }
  };

  bind(keys.toggle, toggleWindow);
  bind(keys.ask, () => {
    showAndFocus();
    send('ui:focus-input');
  });
  bind(keys.screenshotAsk, () => {
    showAndFocus();
    send('ui:quick-ask');
  });
  bind(keys.listen, () => {
    showAndFocus();
    send('ui:toggle-listen');
  });
  bind(keys.reset, () => {
    brain.reset();
    transcript.length = 0;
    send('ui:reset');
  });

  bind('CommandOrControl+Shift+Up', () => nudge(0, -60));
  bind('CommandOrControl+Shift+Down', () => nudge(0, 60));
  bind('CommandOrControl+Shift+Left', () => nudge(-60, 0));
  bind('CommandOrControl+Shift+Right', () => nudge(60, 0));
}

/* ---------------------------------------------------------- answer flow */

let autoAnswer = false;
let lastAutoAt = 0;

// Someone in the call just asked something out loud.
const QUESTIONISH =
  /\?\s*$|^\s*(what|why|how|when|where|who|which|can you|could you|would you|do you|did you|have you|tell me|walk me|explain|describe|give me|talk about)\b/i;

async function runAsk({ question, withScreenshot }) {
  let image = null;
  if (withScreenshot) {
    try {
      image = await grabScreen();
    } catch (err) {
      send('answer:error', err.message);
      return;
    }
  }
  await brain.ask({ question, image, transcript: transcriptText() }, (evt) => {
    if (evt.delta) send('answer:delta', evt.delta);
    else if (evt.error) send('answer:error', evt.error);
    else if (evt.done) send('answer:done', { aborted: Boolean(evt.aborted) });
  });
}

// In auto mode Clue answers the moment it hears a question, without being asked.
function maybeAutoAnswer(line) {
  if (!autoAnswer || brain.busy) return;
  if (!QUESTIONISH.test(line.trim())) return;
  if (Date.now() - lastAutoAt < 8000) return;
  lastAutoAt = Date.now();
  send('answer:auto');
  runAsk({
    question:
      'You just heard the last line of the transcript. Answer it for me now, in my voice, as if you were feeding me the line. No preamble.',
    withScreenshot: false,
  });
}

/* --------------------------------------------------------------- ipc api */

function registerIpc() {
  ipcMain.handle('state:get', () => ({
    ...config.publicView(),
    screenPermission: screenPermission(),
    platform: process.platform,
  }));

  ipcMain.handle('settings:save', (_e, patch) => {
    config.save(patch);
    registerShortcuts();
    return config.publicView();
  });

  ipcMain.handle('ask', (_e, payload) => runAsk(payload));

  ipcMain.on('auto:set', (_e, on) => {
    autoAnswer = Boolean(on);
  });

  ipcMain.on('ask:stop', () => brain.abort());

  ipcMain.on('session:reset', () => {
    brain.reset();
    transcript.length = 0;
    lastAutoAt = 0;
    send('ui:reset');
  });

  // One short audio clip from the renderer's recorder.
  ipcMain.handle('listen:chunk', async (_e, { buffer, mimeType }) => {
    try {
      const text = await transcribe(Buffer.from(buffer), mimeType);
      if (!text) return null;
      transcript.push(text);
      if (transcript.length > 200) transcript.shift();
      send('transcript:line', text);
      maybeAutoAnswer(text);
      return text;
    } catch (err) {
      send('listen:error', err.message);
      return null;
    }
  });

  ipcMain.on('ui:height', (_e, height) => {
    if (!win || win.isDestroyed()) return;
    const target = Math.max(BAR_HEIGHT, Math.min(Math.round(height), 900));
    const [w, h] = win.getSize();
    if (h === target) return;
    // macOS pins min = max = current size on a non-resizable window, so a
    // programmatic resize needs the flag lifted for the duration of the call.
    win.setResizable(true);
    win.setSize(w, target, false);
    win.setResizable(false);
  });

  // Click-through everywhere except over actual controls.
  ipcMain.on('ui:mouse', (_e, interactive) => {
    if (!win) return;
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  ipcMain.on('window:hide', () => win && win.hide());
  ipcMain.on('window:move', (_e, { dx, dy }) => nudge(dx, dy));
  ipcMain.on('app:quit', () => app.quit());
  ipcMain.on('open:external', (_e, url) => shell.openExternal(url));
  ipcMain.on('open:screen-settings', () => {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  });
}

/* ---------------------------------------------------------------- launch */

// Only one overlay at a time; a second launch just reveals the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showAndFocus());

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    // getDisplayMedia() in the renderer: hand back the whole screen plus system
    // audio, so Listen mode hears the other side of the call, not just the mic.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
          .catch(() => callback({}));
      },
      { useSystemPicker: false }
    );

    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['media', 'audioCapture', 'display-capture'].includes(permission));
    });

    registerIpc();
    createWindow();
    registerShortcuts();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
