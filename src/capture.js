'use strict';

const { desktopCapturer, screen, systemPreferences } = require('electron');

const MAX_WIDTH = 1512; // enough for the model to read code; keeps image tokens sane

function screenPermission() {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
}

/**
 * Grabs the display the cursor is on and returns raw PNG base64.
 * The overlay itself is excluded by setContentProtection(true).
 */
async function grabScreen() {
  if (screenPermission() !== 'granted') {
    const err = new Error(
      'Screen Recording permission is off. Open System Settings > Privacy & Security > Screen & System Audio Recording and enable Clue (or your terminal), then restart Clue.'
    );
    err.code = 'NO_SCREEN_PERMISSION';
    throw err;
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.size;
  const scale = Math.min(1, MAX_WIDTH / width);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    },
    fetchWindowIcons: false,
  });

  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('Could not capture the screen.');
  }
  return source.thumbnail.toPNG().toString('base64');
}

module.exports = { grabScreen, screenPermission };
