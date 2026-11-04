// Text-to-speech: German voice selection and announcement texts.
import { PHASE } from './rules.js';

// Players are announced by their point signal word (set via setPlayerNames).
export const PLAYER = ['Spieler 1', 'Spieler 2'];

export function setPlayerNames(words) {
  PLAYER[0] = words && words[0] ? cap(words[0]) : 'Spieler 1';
  PLAYER[1] = words && words[1] ? cap(words[1]) : 'Spieler 2';
}

function cap(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// voice = null means "system default for de-DE" (common on Android, where Chrome often lists
// no voices at all and the Android TTS settings decide which German voice is used).
let voice = null;
let preferredName = null;

export function germanVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith('de'));
}

function pickVoice() {
  const de = germanVoices();
  voice =
    (preferredName && de.find((v) => v.name === preferredName)) ||
    de.find((v) => v.localService) ||
    de[0] ||
    null;
  return voice;
}

// preferred: voice name chosen in the settings, or null for automatic.
export function setPreferredVoice(name) {
  preferredName = name || null;
  pickVoice();
}

// Picks a voice now and again whenever the browser's voice list changes (it loads
// asynchronously, sometimes seconds later). onChange is called after every (re)pick.
export function initVoice(onChange) {
  if (!('speechSynthesis' in window)) return;
  const update = () => {
    pickVoice();
    if (onChange) onChange();
  };
  speechSynthesis.addEventListener('voiceschanged', update);
  update();
  setTimeout(update, 2000);
}

// local: true = on-device voice, false = online voice, null = system default (unknown).
export function voiceInfo() {
  if (!('speechSynthesis' in window)) return { name: 'keine Sprachausgabe', local: false };
  if (!voice) return { name: 'Systemstimme (Deutsch)', local: null };
  return { name: voice.name, local: voice.localService };
}

const RATE = 1.2;
// Time allowed for the last word after its boundary event, per character, plus a margin.
// Conservative on purpose: the last word is often a player name, which is also a signal word.
const LAST_WORD_MS_PER_CHAR = 110;
const LAST_WORD_MARGIN_MS = 250;

// Speaks one utterance, cancelling anything still queued. Resolves when the speech is over.
// "Over" is whichever comes first:
//  - the last word's boundary event + an estimated word duration (Windows voices fire onend
//    ~0.7 s after the audio has actually stopped),
//  - onend / onerror (an onend before onstart is ignored: Chrome fires that spuriously
//    right after cancel()),
//  - a timeout based on text length (onend is unreliable on some Android builds).
export function speak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve();
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    if (!voice) pickVoice();
    const spoken = spokenText(text);
    const u = new SpeechSynthesisUtterance(spoken);
    u.lang = 'de-DE';
    if (voice) u.voice = voice;
    u.rate = RATE;
    const lastWordAt = spoken.trimEnd().search(/\S+$/);
    const lastWordLen = spoken.length - lastWordAt;
    let started = false;
    let finished = false;
    let lastWordTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(lastWordTimer);
      resolve();
    };
    const timer = setTimeout(finish, 1500 + spoken.length * 90);
    u.onstart = () => {
      started = true;
    };
    u.onboundary = (e) => {
      started = true;
      if (e.name === 'word' && e.charIndex >= lastWordAt && !lastWordTimer) {
        const ms = (lastWordLen * LAST_WORD_MS_PER_CHAR) / RATE + LAST_WORD_MARGIN_MS;
        lastWordTimer = setTimeout(finish, ms);
      }
    };
    let retried = false;
    u.onend = () => {
      if (started) return finish();
      // Ended without ever starting: Chrome dropped it (seen after idle periods). Retry once.
      if (!retried) {
        retried = true;
        speechSynthesis.speak(u);
      }
    };
    u.onerror = finish;
    speechSynthesis.speak(u);
  });
}

// Must be called inside a user gesture once, so later speak() calls work on Android.
export function unlockSpeech() {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

// ---- Announcement texts ----

// Numbers are spelled out: TTS reads a digit followed by a period as an ordinal
// ("21 zu 3." -> "einundzwanzig zu dritter").
const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun',
  'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn',
  'neunzehn'];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig',
  'neunzig'];

// Safety net for every spoken text: digits become words, so "Spieler 1." is never read
// as an ordinal ("Spieler erster").
export function spokenText(text) {
  return text.replace(/\d+/g, (m) => num(Number(m)));
}

export function num(n) {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const o = n % 10;
    if (o === 0) return t;
    return (o === 1 ? 'ein' : ONES[o]) + 'und' + t;
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return (h === 1 ? 'ein' : ONES[h]) + 'hundert' + (r ? num(r) : '');
  }
  return String(n);
}

export function scoreText(s) {
  const [a, b] = s.score;
  if (a >= 20 && b >= 20) {
    if (a === b) return 'Einstand';
    return `Vorteil ${PLAYER[a > b ? 0 : 1]}`;
  }
  // Server's score first.
  const srv = s.server ?? 0;
  return `${num(s.score[srv])} zu ${num(s.score[1 - srv])}`;
}

export function tallyText(s) {
  const [a, b] = s.games;
  if (a === b) return `Es steht ${num(a)} zu ${num(b)}.`;
  const lead = a > b ? 0 : 1;
  return `${PLAYER[lead]} führt ${num(Math.max(a, b))} zu ${num(Math.min(a, b))}.`;
}

export function gameOverText(s) {
  const w = s.winner;
  return `${PLAYER[w]} gewinnt ${num(s.score[w])} zu ${num(s.score[1 - w])}. ${tallyText(s)}`;
}

export function serverText(p) {
  return `Aufschlag ${PLAYER[p]}`;
}

// Full description of the current state (used after undo and on resume).
export function stateText(s) {
  switch (s.phase) {
    case PHASE.CHOOSE_SERVER:
      return 'Wer hat Aufschlag?';
    case PHASE.PLAYING:
      return `${scoreText(s)}, ${serverText(s.server)}`;
    case PHASE.OVER:
      return gameOverText(s);
    default:
      return '';
  }
}

// Text for a transition from `prev` to `next` caused by event `ev`.
export function transitionText(prev, next, ev) {
  switch (ev.t) {
    case 'server':
      return `${serverText(next.server)}. Null zu null.`;
    case 'point': {
      if (next.phase === PHASE.OVER) return gameOverText(next);
      let t = scoreText(next);
      if (next.server !== prev.server) t += `, ${serverText(next.server)}`;
      return t;
    }
    case 'newGame':
      return `Neues Spiel. Wer hat Aufschlag?`;
    default:
      return '';
  }
}
