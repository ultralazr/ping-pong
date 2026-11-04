import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState, canApply, serverFor, PHASE } from '../rules.js';

const pts = (...ps) => ps.map((p) => ({ t: 'point', p }));
const rep = (p, n) => Array(n).fill({ t: 'point', p });

test('starts waiting for the server', () => {
  const s = deriveState([]);
  assert.equal(s.phase, PHASE.CHOOSE_SERVER);
  assert.deepEqual(s.score, [0, 0]);
});

test('server event does not score', () => {
  const s = deriveState([{ t: 'server', p: 1 }]);
  assert.equal(s.phase, PHASE.PLAYING);
  assert.equal(s.server, 1);
  assert.deepEqual(s.score, [0, 0]);
});

test('points before a server is chosen are rejected', () => {
  assert.equal(canApply(deriveState([]), { t: 'point', p: 0 }), false);
  assert.deepEqual(deriveState(pts(0, 1)).score, [0, 0]);
});

test('serve changes every five points', () => {
  assert.equal(serverFor(0, [0, 0]), 0);
  assert.equal(serverFor(0, [3, 1]), 0);
  assert.equal(serverFor(0, [3, 2]), 1);
  assert.equal(serverFor(0, [5, 4]), 1);
  assert.equal(serverFor(0, [5, 5]), 0);
  assert.equal(serverFor(1, [10, 5]), 0);
});

test('serve changes every point from 20-20', () => {
  // 40 points = 8 changes -> first server again.
  assert.equal(serverFor(0, [20, 20]), 0);
  assert.equal(serverFor(0, [21, 20]), 1);
  assert.equal(serverFor(0, [21, 21]), 0);
  assert.equal(serverFor(0, [22, 21]), 1);
  // Before deuce the normal rule still applies (e.g. 20-19).
  assert.equal(serverFor(0, [20, 19]), 1);
});

test('game to 21', () => {
  const s = deriveState([{ t: 'server', p: 0 }, ...rep(0, 21)]);
  assert.equal(s.phase, PHASE.OVER);
  assert.equal(s.winner, 0);
  assert.deepEqual(s.games, [1, 0]);
});

test('win by two', () => {
  const base = [{ t: 'server', p: 0 }, ...rep(0, 20), ...rep(1, 20)];
  let s = deriveState([...base, ...pts(0)]);
  assert.equal(s.phase, PHASE.PLAYING);
  s = deriveState([...base, ...pts(0, 1, 1)]);
  assert.equal(s.phase, PHASE.PLAYING);
  s = deriveState([...base, ...pts(0, 1, 1, 1)]);
  assert.equal(s.phase, PHASE.OVER);
  assert.equal(s.winner, 1);
  assert.deepEqual(s.score, [21, 23]);
});

test('points after the game is over are rejected', () => {
  const ev = [{ t: 'server', p: 0 }, ...rep(0, 21)];
  assert.equal(canApply(deriveState(ev), { t: 'point', p: 1 }), false);
});

test('undo (drop last event) un-wins a game', () => {
  const ev = [{ t: 'server', p: 0 }, ...rep(0, 21)];
  const s = deriveState(ev.slice(0, -1));
  assert.equal(s.phase, PHASE.PLAYING);
  assert.deepEqual(s.score, [20, 0]);
  assert.deepEqual(s.games, [0, 0]);
});

test('tally keeps counting across games', () => {
  const g = (p) => [{ t: 'server', p: 0 }, ...rep(p, 21), { t: 'newGame' }];
  const s = deriveState([...g(0), ...g(1), ...g(1), ...g(0), ...g(0)]);
  assert.deepEqual(s.games, [3, 2]);
  assert.equal(s.gameNo, 6);
  assert.equal(s.phase, PHASE.CHOOSE_SERVER);
});

test('new game mid-game abandons it without counting', () => {
  const s = deriveState([{ t: 'server', p: 0 }, ...pts(0, 0, 1), { t: 'newGame' }]);
  assert.deepEqual(s.games, [0, 0]);
  assert.deepEqual(s.score, [0, 0]);
  assert.equal(s.phase, PHASE.CHOOSE_SERVER);
});

test('new game while choosing the server is rejected', () => {
  assert.equal(canApply(deriveState([]), { t: 'newGame' }), false);
});

test('state survives a JSON round trip of the event list', () => {
  const ev = [{ t: 'server', p: 1 }, ...pts(0, 1, 1, 0, 1, 1)];
  const s = deriveState(JSON.parse(JSON.stringify(ev)));
  assert.deepEqual(s.score, [2, 4]);
  assert.equal(s.server, 0);
});
