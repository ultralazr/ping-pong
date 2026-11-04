import { deriveState, canApply, PHASE } from './rules.js';
import {
  initVoice,
  voiceInfo,
  germanVoices,
  setPreferredVoice,
  speak,
  unlockSpeech,
  setPlayerNames,
  transitionText,
  stateText,
  PLAYER,
} from './voice.js';
import { Listener } from './speech.js';

const MODEL_URL = 'models/vosk-model-small-de-0.15.tar.gz';
const STORE_KEY = 'tt-voice-scorer';
const CMD_LABEL = ['Spieler 1', 'Spieler 2', 'Rückgängig', 'Neues Spiel'];
const CMD = { P1: 0, P2: 1, UNDO: 2, NEW: 3 };
const REPEAT_COOLDOWN_MS = 1500; // same voice command again within this window is ignored
const RESUME_TAIL_MS = 150; // keep the mic paused this long after an announcement
const QUIET_DB = -45; // utterances whose peak stays below this are flagged as too quiet
const LOG_SIZE = 8;

const $ = (id) => document.getElementById(id);

// ---------- Persistence ----------

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.version === 1) return s;
  } catch (e) {
    /* ignore */
  }
  return { version: 1, words: null, events: [], threshold: 0.6, debug: true };
}
const store = loadStore();
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) {
    console.warn('save failed', e);
  }
}

let state = deriveState(store.events);

// ---------- Status pills ----------

function pill(id, text, cls) {
  const el = $(id);
  el.firstChild.nodeValue = text + ' ';
  el.classList.toggle('ok', cls === 'ok');
  el.classList.toggle('bad', cls === 'bad');
}

// ---------- Speaking with mic pause ----------

let sayToken = 0;
async function say(text) {
  const my = ++sayToken;
  listener.pause();
  $('level').classList.add('paused');
  micState('paused');
  await speak(text);
  await new Promise((r) => setTimeout(r, RESUME_TAIL_MS));
  if (my !== sayToken) return; // a newer announcement took over
  listener.resume();
  peakRms = 0;
  $('level').classList.remove('paused');
  micState('listening');
}

// ---------- Diagnostics ----------

let peakRms = 0; // loudest buffer since the last final result (while listening)

const toDb = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -100);

function micState(st) {
  const el = $('mic-state');
  el.className = 'mic-state ' + st;
  el.textContent = st === 'paused' ? 'Pausiert (Ansage)' : 'Hört zu';
}

function showLevel(rms) {
  if (!listener.paused) peakRms = Math.max(peakRms, rms);
  if (!store.debug) return;
  const db = toDb(rms);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const bar = $('meter-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('quiet', db < QUIET_DB);
  $('meter-db').textContent = (db < -99 ? '-inf' : db.toFixed(0)) + ' dB';
}

function logResult(r, outcome, ok) {
  const db = toDb(peakRms);
  peakRms = 0;
  const tr = document.createElement('tr');
  tr.className = ok ? 'ok' : 'bad';
  const t = new Date().toLocaleTimeString('de-AT', { hour12: false });
  const cells = [t, fmtWords(r.words) || r.text, `${db.toFixed(0)} dB`, outcome];
  cells.forEach((c, i) => {
    const td = document.createElement('td');
    td.textContent = c;
    if (i === 2 && db < QUIET_DB) {
      td.className = 'quiet';
      td.textContent += ' (leise)';
    }
    tr.appendChild(td);
  });
  const log = $('log');
  log.prepend(tr);
  while (log.children.length > LOG_SIZE) log.lastChild.remove();
}

// ---------- Recognition ----------

let mode = 'start'; // start | setup | test | play
let lastVoice = { cmd: -1, at: 0 };

const listener = new Listener({
  onResult: (r) => handleResult(r),
  onPartial: (p) => {
    if (p) showHeard(p + ' ...');
  },
  onLevel: (lvl) => {
    $('level').style.setProperty('--lvl', Math.min(100, Math.round(lvl * 400)) + '%');
    showLevel(lvl);
  },
  onError: (e) => {
    console.error(e);
    debug('Fehler: ' + e);
  },
});

function showHeard(text) {
  if (mode === 'setup') $('setup-heard').textContent = text;
  else if (mode === 'test') $('test-heard').textContent = text;
  debug('hört: ' + text);
}

function debug(text) {
  $('diag-partial').textContent = text;
}

function fmtWords(words) {
  return words.map((w) => `${w.word}(${(w.conf ?? 1).toFixed(2)})`).join(' ');
}

// Maps a final result to one command index, or null with a reason.
function matchCommand(r) {
  const words = r.words.length
    ? r.words
    : r.text.split(/\s+/).map((w) => ({ word: w, conf: 1 }));
  const hits = new Set();
  let low = null;
  for (const w of words) {
    const idx = store.words.indexOf(w.word);
    if (idx < 0) continue;
    const conf = w.conf ?? 1;
    if (conf < store.threshold) {
      low = low === null ? conf : Math.max(low, conf);
      continue;
    }
    hits.add(idx);
  }
  if (hits.size === 1) return { cmd: [...hits][0] };
  if (hits.size > 1) return { cmd: null, reason: 'mehrdeutig (mehrere Signalwörter)' };
  if (low !== null) {
    return {
      cmd: null,
      reason: `Konfidenz zu niedrig (${low.toFixed(2)} < ${store.threshold.toFixed(2)})`,
    };
  }
  return { cmd: null, reason: 'kein Signalwort' };
}

function handleResult(r) {
  debug('hört: -');
  if (mode === 'setup') {
    logResult(r, 'Setup', true);
    return setupHeard(r);
  }
  if (mode === 'test') {
    const m = matchCommand(r);
    logResult(r, m.cmd === null ? m.reason : '-> ' + CMD_LABEL[m.cmd], m.cmd === testIdx);
    return testHeard(r);
  }
  if (mode !== 'play') return;
  const m = matchCommand(r);
  if (m.cmd === null) return logResult(r, m.reason, false);
  const now = Date.now();
  if (m.cmd === lastVoice.cmd && now - lastVoice.at < REPEAT_COOLDOWN_MS) {
    return logResult(r, `ignoriert: Wiederholung innerhalb ${REPEAT_COOLDOWN_MS / 1000} s`, false);
  }
  lastVoice = { cmd: m.cmd, at: now };
  const isPoint = m.cmd === CMD.P1 || m.cmd === CMD.P2;
  if (isPoint && state.phase === PHASE.OVER) {
    logResult(r, 'ignoriert: Spiel vorbei', false);
  } else {
    logResult(r, '-> ' + CMD_LABEL[m.cmd], true);
  }
  command(m.cmd);
}

// ---------- Game commands ----------

function command(cmd) {
  flash(cmd);
  switch (cmd) {
    case CMD.P1:
    case CMD.P2: {
      const p = cmd;
      if (state.phase === PHASE.CHOOSE_SERVER) return push({ t: 'server', p });
      if (state.phase === PHASE.PLAYING) return push({ t: 'point', p });
      $('phase-msg').textContent = `Spiel vorbei. Neues Spiel mit "${store.words[CMD.NEW]}".`;
      return;
    }
    case CMD.UNDO:
      if (!store.events.length) return say('Nichts rückgängig zu machen.');
      store.events.pop();
      save();
      state = deriveState(store.events);
      render();
      return say('Zurück. ' + stateText(state));
    case CMD.NEW:
      if (state.phase === PHASE.CHOOSE_SERVER) return say('Wer hat Aufschlag?');
      return push({ t: 'newGame' });
  }
}

function push(ev) {
  if (!canApply(state, ev)) return;
  const prev = state;
  store.events.push(ev);
  save();
  state = deriveState(store.events);
  render();
  say(transitionText(prev, state, ev));
}

function flash(cmd) {
  const b = document.querySelector(`.cmd[data-cmd="${cmd}"]`);
  if (!b) return;
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 400);
}

// ---------- Rendering ----------

function render() {
  setPlayerNames(store.words);
  for (const p of [0, 1]) {
    const el = $('pl' + p);
    el.querySelector('.name').firstChild.nodeValue = PLAYER[p] + ' ';
    el.querySelector('.score').textContent = state.score[p];
    el.querySelector('.games b').textContent = state.games[p];
    el.classList.toggle('serving', state.phase === PHASE.PLAYING && state.server === p);
    el.classList.toggle('winner', state.phase === PHASE.OVER && state.winner === p);
  }
  const w = store.words || [];
  let msg = `Spiel ${state.gameNo}`;
  if (state.phase === PHASE.CHOOSE_SERVER) {
    msg += ` - Wer hat Aufschlag? ("${w[0] ?? '1'}" oder "${w[1] ?? '2'}")`;
  } else if (state.phase === PHASE.OVER) {
    msg += ` - ${PLAYER[state.winner]} gewinnt`;
  }
  $('phase-msg').textContent = msg;
  document.querySelectorAll('.cmd').forEach((b) => {
    b.querySelector('small').textContent = w[+b.dataset.cmd] ?? '';
  });
  $('thr').value = store.threshold;
  $('thr-val').textContent = store.threshold.toFixed(2);
  $('dbg').checked = store.debug;
  $('diag').hidden = !store.debug || mode === 'start';
}

function show(screen) {
  mode = screen;
  for (const s of ['start', 'setup', 'test', 'play']) $(s).hidden = s !== screen;
  $('diag').hidden = !store.debug || screen === 'start';
}

// ---------- Setup: choosing signal words ----------

let draft = [];
let setupIdx = 0;

function startSetup(keepWords) {
  draft = keepWords && store.words ? [...store.words] : [];
  setupIdx = 0;
  $('setup-cancel').hidden = !store.words;
  show('setup');
  listener.setGrammar(null);
  renderSetup();
  say(`Sag dein Wort für ${CMD_LABEL[0]}.`);
}

function renderSetup() {
  $('setup-step').textContent = setupIdx + 1;
  $('setup-cmd').textContent = CMD_LABEL[setupIdx];
  $('setup-heard').textContent = '...';
  $('setup-chips').innerHTML = '';
  $('setup-error').textContent = '';
  $('setup-input').value = '';
  $('setup-list').innerHTML = CMD_LABEL.map(
    (l, i) => `<li>${l}: <b>${draft[i] ?? '-'}</b>${i === setupIdx ? ' &larr;' : ''}</li>`
  ).join('');
  $('setup-back').disabled = setupIdx === 0;
}

function setupHeard(r) {
  $('setup-heard').textContent = r.text;
  const words = r.text.split(/\s+/).filter((w) => w && w !== '[unk]');
  $('setup-chips').innerHTML = '';
  for (const w of words) {
    const b = document.createElement('button');
    b.textContent = w;
    b.onclick = () => acceptWord(w);
    $('setup-chips').appendChild(b);
  }
}

function validateWord(word, idx) {
  if (!/^[a-zäöüß]+$/.test(word)) return 'Bitte genau ein Wort (nur Buchstaben).';
  if (word.length < 2) return 'Wort zu kurz.';
  for (let i = 0; i < 4; i++) {
    const o = draft[i];
    if (i === idx || !o) continue;
    if (o === word) return `"${word}" ist schon für ${CMD_LABEL[i]} vergeben.`;
    if (o.startsWith(word) || o.endsWith(word) || word.startsWith(o) || word.endsWith(o)) {
      return `"${word}" ist zu ähnlich zu "${o}" (${CMD_LABEL[i]}).`;
    }
  }
  return null;
}

function acceptWord(raw) {
  const word = raw.trim().toLowerCase();
  const err = validateWord(word, setupIdx);
  if (err) {
    $('setup-error').textContent = err;
    return;
  }
  draft[setupIdx] = word;
  setupIdx++;
  if (setupIdx < 4) {
    renderSetup();
    say(`${word}. Jetzt ${CMD_LABEL[setupIdx]}.`);
  } else {
    startTest();
  }
}

// ---------- Test round (grammar mode) ----------

let testIdx = 0;

function startTest() {
  testIdx = 0;
  show('test');
  // matchCommand reads store.words, so test with the draft temporarily.
  testWordsBackup = store.words;
  store.words = [...draft];
  listener.setGrammar(draft);
  renderTest();
  say(`Testrunde. Sag ${draft[0]}.`);
}
let testWordsBackup = null;

function renderTest() {
  $('test-step').textContent = testIdx + 1;
  $('test-word').textContent = draft[testIdx];
  $('test-cmd').textContent = `(${CMD_LABEL[testIdx]})`;
  $('test-heard').textContent = '...';
  $('test-result').textContent = '';
  $('test-replace').hidden = true;
}

function testHeard(r) {
  $('test-heard').textContent = fmtWords(r.words) || r.text;
  const m = matchCommand(r);
  if (m.cmd === testIdx) {
    testIdx++;
    if (testIdx < 4) {
      renderTest();
      say(`Gut. Sag ${draft[testIdx]}.`);
    } else {
      finishSetup();
    }
    return;
  }
  const res = $('test-result');
  if (m.cmd === null) {
    res.textContent = `Nicht erkannt (${m.reason}). Nochmal sagen.`;
  } else {
    res.textContent = `Verwechselt mit "${draft[m.cmd]}" (${CMD_LABEL[m.cmd]}). Nochmal sagen oder Wort ändern.`;
    $('test-replace').hidden = false;
  }
}

function finishSetup() {
  store.words = [...draft];
  testWordsBackup = null;
  save();
  enterPlay(true);
}

function leaveTestTo(idx) {
  if (testWordsBackup !== null) store.words = testWordsBackup;
  testWordsBackup = null;
  show('setup');
  listener.setGrammar(null);
  setupIdx = idx;
  $('setup-cancel').hidden = !store.words;
  renderSetup();
  say(`Sag ein neues Wort für ${CMD_LABEL[idx]}.`);
}

// ---------- Play ----------

function enterPlay(announce) {
  show('play');
  listener.setGrammar(store.words);
  render();
  if (announce) say((store.events.length ? '' : "Los geht's. ") + stateText(state));
}

// ---------- Wake lock ----------

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return pill('st-wake', 'Display: kein Wake Lock', 'bad');
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    pill('st-wake', 'Display: bleibt an', 'ok');
    wakeLock.addEventListener('release', () => pill('st-wake', 'Display: frei'));
  } catch (e) {
    pill('st-wake', 'Display: ' + e.name, 'bad');
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || mode === 'start') return;
  requestWakeLock();
  if (listener.ctx && listener.ctx.state !== 'running') listener.ctx.resume();
});

// ---------- Wiring ----------

$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  acceptWord($('setup-input').value);
});
$('setup-back').onclick = () => {
  if (setupIdx > 0) setupIdx--;
  renderSetup();
};
$('setup-cancel').onclick = () => enterPlay(false);
$('test-skip').onclick = () => finishSetup();
$('test-redo').onclick = () => leaveTestTo(0);
$('test-replace').onclick = () => leaveTestTo(testIdx);

document.querySelectorAll('.cmd').forEach((b) => {
  b.addEventListener('click', () => command(+b.dataset.cmd));
});

document.addEventListener('keydown', (e) => {
  if (mode !== 'play' || e.target.tagName === 'INPUT' || e.repeat) return;
  const k = e.key.toLowerCase();
  const map = { 1: CMD.P1, 2: CMD.P2, u: CMD.UNDO, backspace: CMD.UNDO, n: CMD.NEW };
  if (k in map) {
    e.preventDefault();
    command(map[k]);
  }
});

$('thr').addEventListener('input', () => {
  store.threshold = +$('thr').value;
  $('thr-val').textContent = store.threshold.toFixed(2);
  save();
});
$('dbg').addEventListener('change', () => {
  store.debug = $('dbg').checked;
  $('diag').hidden = !store.debug;
  save();
});
$('btn-words').onclick = () => startSetup(true);

let resetArmed = false;
$('btn-reset').onclick = () => {
  if (!resetArmed) {
    resetArmed = true;
    $('btn-reset').textContent = 'Wirklich alles löschen?';
    setTimeout(() => {
      resetArmed = false;
      $('btn-reset').textContent = 'Neue Session';
    }, 4000);
    return;
  }
  resetArmed = false;
  $('btn-reset').textContent = 'Neue Session';
  store.words = null;
  store.events = [];
  save();
  state = deriveState(store.events);
  startSetup(false);
};

// ---------- Boot ----------

const modelReady = listener
  .loadModel(MODEL_URL)
  .then(() => {
    pill('st-model', 'Modell: bereit', 'ok');
    $('start-msg').textContent = 'Bereit. Start tippen.';
  })
  .catch((e) => {
    pill('st-model', 'Modell: Fehler', 'bad');
    $('start-msg').textContent = 'Sprachmodell konnte nicht geladen werden: ' + e;
    throw e;
  });

function showVoice() {
  const v = voiceInfo();
  if (v.local === null) pill('st-voice', `Stimme: ${v.name}`);
  else pill('st-voice', `Stimme: ${v.name}${v.local ? '' : ' (online!)'}`, v.local ? 'ok' : 'bad');
  // Settings dropdown: "automatic" plus every German voice the browser lists.
  const sel = $('voice-sel');
  const list = germanVoices();
  const opts = [['', list.length ? 'Automatisch' : 'Systemstimme (in Android-Einstellungen wählen)']];
  for (const vo of list) opts.push([vo.name, vo.name + (vo.localService ? '' : ' (online)')]);
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    for (const [value, label] of opts) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    }
  }
  sel.value = list.some((vo) => vo.name === store.voice) ? store.voice : '';
}

setPreferredVoice(store.voice);
initVoice(showVoice);

$('voice-sel').addEventListener('change', () => {
  store.voice = $('voice-sel').value || null;
  save();
  setPreferredVoice(store.voice);
  showVoice();
  say(`Aufschlag ${PLAYER[0]}. Sieben zu fünf.`);
});

$('btn-start').onclick = async () => {
  $('btn-start').disabled = true;
  try {
    await listener.startMic();
    pill('st-mic', 'Mikro: an', 'ok');
    micState('listening');
  } catch (e) {
    pill('st-mic', 'Mikro: ' + e.name, 'bad');
    $('start-msg').textContent = 'Kein Mikrofonzugriff: ' + e.message;
    $('btn-start').disabled = false;
    return;
  }
  // Unlock speech synthesis inside the user gesture (needed on Android).
  unlockSpeech();
  requestWakeLock();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  $('start-msg').textContent = 'Sprachmodell wird geladen ...';
  try {
    await modelReady;
  } catch (e) {
    return;
  }
  if (store.words) enterPlay(true);
  else startSetup(false);
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => pill('st-offline', 'Offline: bereit', 'ok'))
    .catch((e) => pill('st-offline', 'Offline: ' + e.message, 'bad'));
} else {
  pill('st-offline', 'Offline: kein Service Worker', 'bad');
}
