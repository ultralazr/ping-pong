import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../rules.js';
import { setPlayerNames, transitionText, stateText, tallyText, num, spokenText } from '../voice.js';

setPlayerNames(['tomate', 'banane', 'zurück', 'neustart']);
const rep = (p, n) => Array(n).fill({ t: 'point', p });

test('players are announced by their signal word', () => {
  const prev = deriveState([]);
  const ev = { t: 'server', p: 1 };
  assert.equal(transitionText(prev, deriveState([ev]), ev), 'Aufschlag Banane. Null zu null.');
});

test('server score first, server change appended', () => {
  const base = [{ t: 'server', p: 0 }, ...rep(1, 3)];
  const prev = deriveState(base);
  const ev = { t: 'point', p: 0 };
  const next = deriveState([...base, ev]);
  // 1-3 for Tomate after 4 points: still Tomate serving -> "1 zu 3"
  assert.equal(transitionText(prev, next, ev), 'eins zu drei');
  const ev2 = { t: 'point', p: 1 };
  const next2 = deriveState([...base, ev, ev2]);
  // 1-4 after 5 points: Banane serves -> Banane's score first
  assert.equal(transitionText(next, next2, ev2), 'vier zu eins, Aufschlag Banane');
});

test('deuce texts', () => {
  const base = [{ t: 'server', p: 0 }, ...rep(0, 20), ...rep(1, 20)];
  assert.match(stateText(deriveState(base)), /^Einstand/);
  assert.match(stateText(deriveState([...base, { t: 'point', p: 1 }])), /^Vorteil Banane/);
});

test('game over text with tally', () => {
  const ev = [{ t: 'server', p: 0 }, ...rep(0, 21)];
  const s = deriveState(ev);
  assert.equal(stateText(s), 'Tomate gewinnt einundzwanzig zu null. Tomate führt eins zu null.');
  const tie = deriveState([...ev, { t: 'newGame' }, { t: 'server', p: 0 }, ...rep(1, 21)]);
  assert.equal(tallyText(tie), 'Es steht eins zu eins.');
});

test('numbers are spelled out in German', () => {
  assert.equal(num(0), 'null');
  assert.equal(num(1), 'eins');
  assert.equal(num(17), 'siebzehn');
  assert.equal(num(20), 'zwanzig');
  assert.equal(num(21), 'einundzwanzig');
  assert.equal(num(37), 'siebenunddreißig');
  assert.equal(num(101), 'einhunderteins');
});

test('no digits left in any announcement', () => {
  const ev = [{ t: 'server', p: 0 }, ...rep(0, 21)];
  assert.doesNotMatch(stateText(deriveState(ev)), /\d/);
  assert.doesNotMatch(stateText(deriveState(ev.slice(0, 13))), /\d/);
});

test('digits in any spoken text become words', () => {
  assert.equal(spokenText('Sag dein Wort für Spieler 1.'), 'Sag dein Wort für Spieler eins.');
  assert.equal(spokenText('Jetzt Spieler 2.'), 'Jetzt Spieler zwei.');
});
