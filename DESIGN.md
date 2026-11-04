# Table Tennis Voice Scorer - Design (rev. 2)

## Goal
A browser app that keeps table tennis score from shouted signal words, announces the score aloud,
and works fully offline on an Android phone standing by the table. First target: Chrome on a Windows
PC (localhost) for testing; second target: Chrome on Android.

## Platform
- Plain HTML + JavaScript (ES modules), no build step. All libraries vendored into the repo, no CDN,
  so the offline path is the same on PC and phone.
- Mic, service worker and Wake Lock all need a secure context:
  - PC test: serve on `http://localhost` (e.g. `npx serve` or `python -m http.server`), which counts as secure.
  - Phone: either HTTPS hosting (e.g. GitHub Pages) or `adb reverse tcp:8080 tcp:8080` so the phone
    also uses `localhost`. A plain LAN IP (`http://192.168.x.x`) will NOT get mic access.
- Installable as a PWA; the service worker caches the app shell and the speech model.
  Call `navigator.storage.persist()` so the ~45 MB model is not evicted.
- Screen Wake Lock keeps the screen on. The lock is dropped by the browser whenever the page is hidden,
  so re-acquire it on `visibilitychange`. Note: on Android the mic stops if the screen turns off or the
  app goes to the background; that is a platform limit, not something the app can fix.

## Speech recognition
- Vosk in the browser via WebAssembly (`vosk-browser`) with `vosk-model-small-de-0.15`
  (small models support runtime grammars, the big ones do not). Model is loaded from a vendored
  `.tar.gz`, cached once.
  - Verified: vosk-browser extracts the model into IndexedDB (keyed by model URL) and skips the
    download when it is already there, so the service worker does not cache the model itself.
    Changing the model means changing its file name.
- Mic via `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`;
  recogniser sample rate = `AudioContext.sampleRate`.
- Continuous listening, no restarts or beeps.
- Two recogniser modes (switching = create a new `KaldiRecognizer` on the same loaded model):
  - **Setup mode:** full vocabulary.
  - **Play mode:** grammar = the four signal words **plus `[unk]`**. Without `[unk]`, Vosk forces every
    noise or chatter onto the closest signal word, which causes false points.
- Only **final** results trigger actions (partials are shown in the debug line only).
  - One action per final result. If a result contains two different signal words, ignore it.
  - Ignore results whose word confidence is below a threshold (start with 0.7, tune on the PC).
  - Point words have a cooldown of ~1.5 s (no rally is shorter), so an echo or a repeated shout
    is not counted twice.
- Recognition is paused while the app is speaking, plus a 150 ms tail. The end of speech is
  detected as the earliest of: last word boundary event + estimated word length (Windows voices
  fire `onend` ~0.7 s after the audio stops), `onend`, or a timeout from the text length
  (`onend` is unreliable on some Android builds). An `onend` before `onstart` means Chrome dropped
  the utterance (seen after idle periods); it is retried once. Audio frames arriving while paused
  are discarded, not buffered.

## Signal words (set per session)
Four commands, chosen fresh each session:
1. Point for Spieler 1 (left)
2. Point for Spieler 2 (right)
3. Undo last action
4. Start new game

Setup flow, for each command:
1. The user says the word; Vosk (full vocabulary) transcribes it; the app shows and speaks it; user
   confirms by tap or retries.
   - The original "warn if not in the model's dictionary" check is not needed: a full-vocabulary
     transcription can only produce dictionary words. The real failure mode is Vosk hearing a
     *different* word than intended, which the confirm step catches (the user taps the right word
     from the transcription). A text field lets the user type the word instead; a typed word that is
     not in the model's vocabulary simply never matches, which the test round reveals.
2. The app rejects a word that is identical to, or a prefix/suffix of, one already chosen.

After all four: **test round** in play mode (four-word grammar). The app asks for each word once and
shows what it recognised; if any is confused with another, go back and replace it. Tip shown in the
UI: pick distinct, ideally two-syllable words that are not said during normal play (avoid "ja",
"nein", "aus", numbers, player names).

Signal words are stored with the session (see Persistence), so a reload does not force a new setup.
"New session" in the UI clears everything and restarts setup.

## Game rules
- Game to 21, win by two.
- Serve alternates every five points; from 20-20 (deuce) it alternates every point.
- Player one = the player on the left side of the screen.
- **During play, players are named by their point signal word** (board and all score/serve/game
  announcements). The command buttons and setup prompts are labelled "Spieler 1"/"Spieler 2";
  before setup the board shows those too.

## Game flow
States: `setup` -> `choose-server` -> `playing` -> `game-over` -> (new game) `choose-server` -> ...

- **New game:** the app asks "Wer hat Aufschlag?". The user answers with player one's or player two's
  point word; this sets the first server and does not score a point. While waiting, undo and new game
  words still work; nothing else does.
- **Playing:** point words score; undo; new game mid-game abandons the current game (it does not count
  towards the tally) and goes to `choose-server`. Undo restores it if this was a misrecognition.
- **Game over:** after the winning point, point words are ignored. Undo un-wins the game (removes the
  winning point); new game starts the next one.

## Announcements (offline browser text-to-speech, German voice)
- Voice choice: prefer a German voice with `localService === true`. On Windows that is "Microsoft
  Hedda/Katja" (needs the German speech pack); "Google Deutsch" in desktop Chrome is network-based and
  will not work offline. On Android the German Google TTS voice must be downloaded in the system TTS
  settings for offline use. The app shows which voice it uses and warns if none is local.
- One utterance per event (never queue several), so the dead time after a point stays short.
Examples below use "Tomate" (left) and "Banane" (right) as point words.
- After every point: score with the **server's score first** (table tennis convention), e.g. "sieben zu fünf".
- When the server changes, append it to the same utterance: "sieben zu fünf, Aufschlag Banane".
- From 20-20: "Einstand" / "Vorteil Tomate" instead of the raw numbers.
- After every game: winner, final score and session tally, e.g. "Tomate gewinnt 21 zu 17.
  Tomate führt drei zu zwei." On a tied tally: "Es steht zwei zu zwei."
- After undo: announce the restored score (so players know the undo took effect).

## Session tracking
- Track games won per player across the session. No match limit: games continue indefinitely and the
  tally keeps counting up.

## Architecture
- **Event log:** the match is a list of events: `serverSet(player)`, `point(player)`, `newGame`.
  Score, server, game state and tally are derived by replaying the list with a pure function
  `deriveState(events) -> state`.
- **Undo is not an event;** it removes the last event from the list. (The original draft listed undo
  as an event type and also as "drop last event"; those conflict.) Undo with an empty list does nothing.
- Events that are invalid in the current state (e.g. a point during `game-over`) are rejected before
  they enter the log, so the log only ever holds valid events.
- **Persistence:** `localStorage` holds `{ version, signalWords, events }`, written after every change.
- Modules:
  - `rules.js` - pure scoring logic (`deriveState`, serve rotation, win detection). Unit-tested with
    `node --test`, no browser needed (announcement texts in `voice.js` too).
  - `speech.js` - Vosk loading, mode switching, pause/resume, result filtering.
  - `voice.js` - TTS voice selection and announcement texts.
  - `app.js` - state machine, UI, persistence, wake lock.
  - `sw.js` - service worker.

## UI
- Large score display readable from ~3 m, current server marked, game tally below.
- **On-screen buttons** for all four commands (also keyboard keys 1, 2, U, N on the PC). Needed for
  testing on the PC and as a fallback when recognition fails at the table.
- Debug line: last partial / final result with confidence, mic level, current recogniser mode.
  Toggleable.
- Status: model loading progress, mic active / paused, wake lock active, offline ready.

## Test plan on the PC (before the phone)
1. `node --test` for `rules.js`: 21-point wins, win by two, serve every 5 points, every point from
   20-20, undo across a game end, new game mid-game, reload restore.
2. Chrome on localhost, buttons only: full game flow and announcements.
3. Voice: setup flow, test round, play mode with background noise (play a table tennis video
   alongside) to tune the confidence threshold and cooldown.
4. Offline: DevTools -> Network -> Offline, reload, everything still works.
5. Then the phone (HTTPS or `adb reverse`), check German offline TTS voice and wake lock.

## Install on the phone
Preferred: static HTTPS hosting (GitHub Pages; free Pages needs a public repo, and the content holds no
personal data).
1. Open the Pages URL in Chrome on Android over WiFi.
2. Chrome menu -> "Install app" / "Add to Home screen".
3. First launch: allow the microphone; the app downloads and caches the ~45 MB model once.
4. Android Settings -> Text-to-speech -> Google speech services -> install German voice data (offline voice).
5. Test once in airplane mode. From then on no network is needed.
Updates: when the phone is online and the app is opened, the service worker fetches the new version and
uses it on the next start. The cached model is only downloaded again if its file name changes.

Alternative without hosting: USB debugging + `adb reverse tcp:8080 tcp:8080`, serve on the PC, open
`http://localhost:8080` on the phone and install from there. Works offline afterwards, but updates
need the USB cable and the PC server again.

## Reference repos
- https://github.com/Yeisonfjrd/pingpong-scoreboard
- https://github.com/sam9128/pingpong-scoreboard

(UI ideas only; check their licences before copying any code.)
