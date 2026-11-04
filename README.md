# TT Voice Scorer

Offline table tennis scorer for the browser (PWA). Shout your signal words, the app keeps score
and announces it in German. Speech recognition runs fully on the device with
[Vosk](https://alphacephei.com/vosk/) (WebAssembly), no server and no network needed after the
first load.

**App:** https://ultralazr.github.io/ping-pong/

## Use
1. Open the app in Chrome (Android or desktop), install it via the Chrome menu ("Install app" /
   "Add to Home screen").
2. Tap **Start**, allow the microphone. The German speech model (~45 MB) is downloaded once.
3. Choose four signal words (point left, point right, undo, new game), do the test round, play.
4. Android: install the German offline voice (Settings -> Text-to-speech -> Google speech
   services -> install voice data -> Deutsch).

Rules: game to 21, win by two, serve changes every 5 points, from 20-20 every point.
See [DESIGN.md](DESIGN.md) for details.

## Develop
```
node serve.js      # http://localhost:8080/
npm test           # unit tests for scoring and announcement texts
```

## Third-party
- [vosk-browser](https://github.com/ccoreilly/vosk-browser) (`vendor/vosk.js`), Apache-2.0
- [vosk-model-small-de-0.15](https://alphacephei.com/vosk/models), Apache-2.0
  (`models/COPYING-vosk-model`)
