# Clue

An invisible AI overlay for macOS. It floats above every app, stays out of screen
shares and recordings, reads your screen when you ask, listens to your call, and
streams answers from GPT-6 Astra — without ever showing up in the window
you're sharing.

## Run it

```bash
npm install
npm start
```

The settings panel opens on first launch. Paste an OpenAI API key
(<https://platform.openai.com/api-keys>) and hit **Save**. That is the only key
Clue needs — Listen mode reuses it too, so there is nothing else to fill in.

You can also start it with the key in the environment, and skip the panel:

```bash
OPENAI_API_KEY=sk-proj-... npm start
```

Keys you type into settings are encrypted with the macOS Keychain before they
touch disk (`~/Library/Application Support/Clue/config.json`).

## Shortcuts

| Keys | What it does |
|---|---|
| `⌘ \` | Show / hide the overlay |
| `⌘ ↵` | Jump to the ask box |
| `⌘ ⇧ ↵` | Answer from what's on screen right now |
| `⌘ L` | Start / stop listening to the call |
| `⌘ ⇧ R` | New session — forgets the conversation and transcript |
| `⌘ ⇧ arrows` | Move the overlay around |
| `⌘ ,` | Settings |
| `Esc` | Stop the answer, or hide |

All five main shortcuts are editable in settings.

## Two permissions macOS will ask for

- **Screen Recording** — needed to read your screen. System Settings › Privacy &
  Security › Screen & System Audio Recording. Grant it to *Clue* (or to your
  terminal, if you're running `npm start` from one), then restart the app.
- **Microphone** — only needed for Listen mode.

Nothing is captured until you ask for it: screenshots are taken at the moment you
press the key, and the microphone is off until you turn Listen on.

## Auto mode

Turn on **Auto** next to Listen and Clue stops waiting to be asked: whenever the
transcript picks up a question, it answers it immediately, in your voice, ready
to read out. It fires at most once every 8 seconds and never talks over an answer
already in flight. Auto needs Listen on — it has nothing to react to otherwise.

## Listen mode

Listen mixes your microphone with the system audio of the call (so you get both
sides), slices it into 7-second clips, skips the silent ones, and transcribes
them. The rolling transcript is sent along with your next question, so "what do I
say to that?" actually knows what *that* was.

Transcription is a separate endpoint. It defaults to OpenAI's
`gpt-4o-transcribe` and reuses your OpenAI key, so it works out of the box.
Any OpenAI-compatible `/v1/audio/transcriptions` endpoint can take its place —
set the key, endpoint and model in settings:

| Service | Endpoint | Model |
|---|---|---|
| OpenAI (default) | `https://api.openai.com/v1` | `gpt-4o-transcribe` or `whisper-1` |
| Local whisper.cpp server | `http://127.0.0.1:8080/v1` | `whisper-1` |

Without any key Listen is just off; everything else still works.

## Models

| Setting | What it does |
|---|---|
| **Model** | Fixed to **GPT-5.6 Sol**, OpenAI's flagship GPT-5.6 model for complex professional work. |
| **Effort** | Fixed to **High** for stronger reasoning. |

Effort is fixed to **High** for more accurate coding and reasoning. Sol can see
screenshots, so ⌘⇧↩ works on anything on screen.

## What it costs

Billed per API call by OpenAI. A screenshot is roughly 1.5k input tokens. Lower
the effort if you are asking constantly during a long call. The system prompt is
cached, so follow-up questions in a session are cheaper than the first.

## Running it as a real app

```bash
npm run app     # build + install to /Applications, then launch from Spotlight
```

`Clue.app` has no Dock icon and no menu bar — it is a background app, so it only
ever appears as the overlay. `⌘\` shows and hides it; **Quit Clue** at the bottom
of the settings panel (`⌘ ,`) is how you exit.

It shares its settings with `npm start`, so the key you saved in one is already
there in the other.

macOS ties Screen Recording permission to the exact binary, so grant it to *Clue*
(not your terminal) the first time, then relaunch.

```bash
npm run pack    # just the unpacked .app in dist/
npm run dist    # .dmg + .zip, for handing to someone else
```

The build is unsigned. A copy someone downloads will be quarantined — right-click
› Open, or `xattr -dr com.apple.quarantine /Applications/Clue.app`. For a signed
and notarized build, add your Developer ID to the `mac` block in `package.json`.

## How it's put together

```
src/main.js      window, stealth flags, global shortcuts, IPC
src/preload.js   the only bridge the page gets
src/llm.js       the Brain — neutral history, one system prompt
src/openai.js    OpenAI Responses API streaming — vision, effort, caching
src/capture.js   screenshot of the display the cursor is on
src/stt.js       audio clip -> text
src/config.js    settings + Keychain-encrypted keys
renderer/        the overlay UI (no framework, no build step)
```

Three lines in `src/main.js` do the invisibility: `setContentProtection(true)`
keeps the window out of screen captures and shares, `setAlwaysOnTop(…, 'screen-saver')`
floats it above full-screen apps, and `setVisibleOnAllWorkspaces` keeps it on
every Space. The window is click-through by default — the renderer only turns the
mouse back on while the pointer is over an actual control.

## Fair warning

Content protection hides the window from macOS screen capture APIs, which covers
Zoom, Meet, Teams, QuickTime and the like. It does not hide it from a camera
pointed at your screen, and it is not a defence against proctoring software that
looks for running processes. Using this in an interview or exam that forbids
assistance is on you.
