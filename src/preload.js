'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('clue', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  ask: (question, withScreenshot) => ipcRenderer.invoke('ask', { question, withScreenshot }),
  stopAsk: () => ipcRenderer.send('ask:stop'),
  resetSession: () => ipcRenderer.send('session:reset'),
  setAuto: (on) => ipcRenderer.send('auto:set', on),

  sendAudio: (buffer, mimeType) => ipcRenderer.invoke('listen:chunk', { buffer, mimeType }),

  setHeight: (h) => ipcRenderer.send('ui:height', h),
  setMouseInteractive: (v) => ipcRenderer.send('ui:mouse', v),
  hide: () => ipcRenderer.send('window:hide'),
  move: (dx, dy) => ipcRenderer.send('window:move', { dx, dy }),
  quit: () => ipcRenderer.send('app:quit'),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  openScreenSettings: () => ipcRenderer.send('open:screen-settings'),

  onDelta: on('answer:delta'),
  onDone: on('answer:done'),
  onAuto: on('answer:auto'),
  onError: on('answer:error'),
  onTranscriptLine: on('transcript:line'),
  onListenError: on('listen:error'),
  onFocusInput: on('ui:focus-input'),
  onQuickAsk: on('ui:quick-ask'),
  onToggleListen: on('ui:toggle-listen'),
  onReset: on('ui:reset'),
});
