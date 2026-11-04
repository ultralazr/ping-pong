// Pure scoring logic. The match is a list of events; everything else is derived.
//
// Events:
//   { t: 'server', p: 0|1 }  first server of the current game
//   { t: 'point',  p: 0|1 }  point for player p
//   { t: 'newGame' }         start a new game (abandons an unfinished one)
//
// Undo is not an event: it removes the last event from the list.

export const POINTS_TO_WIN = 21;
export const SERVES_PER_TURN = 5;

export const PHASE = {
  CHOOSE_SERVER: 'choose-server',
  PLAYING: 'playing',
  OVER: 'over',
};

export function initialState() {
  return {
    phase: PHASE.CHOOSE_SERVER,
    score: [0, 0],
    firstServer: null,
    server: null,
    winner: null,
    games: [0, 0],
    gameNo: 1,
  };
}

export function serverFor(firstServer, score) {
  const [a, b] = score;
  const deuceLine = POINTS_TO_WIN - 1;
  let changes;
  if (a >= deuceLine && b >= deuceLine) {
    // Every point from 20-20 on.
    const atDeuce = Math.floor((2 * deuceLine) / SERVES_PER_TURN);
    changes = atDeuce + (a + b - 2 * deuceLine);
  } else {
    changes = Math.floor((a + b) / SERVES_PER_TURN);
  }
  return changes % 2 === 0 ? firstServer : 1 - firstServer;
}

export function isGameWon(score) {
  const [a, b] = score;
  return Math.max(a, b) >= POINTS_TO_WIN && Math.abs(a - b) >= 2;
}

export function canApply(state, ev) {
  switch (ev.t) {
    case 'server':
      return state.phase === PHASE.CHOOSE_SERVER && (ev.p === 0 || ev.p === 1);
    case 'point':
      return state.phase === PHASE.PLAYING && (ev.p === 0 || ev.p === 1);
    case 'newGame':
      return state.phase !== PHASE.CHOOSE_SERVER;
    default:
      return false;
  }
}

export function apply(state, ev) {
  if (!canApply(state, ev)) return state;
  const s = { ...state, score: [...state.score], games: [...state.games] };
  switch (ev.t) {
    case 'server':
      s.phase = PHASE.PLAYING;
      s.firstServer = ev.p;
      s.server = ev.p;
      break;
    case 'point':
      s.score[ev.p] += 1;
      s.server = serverFor(s.firstServer, s.score);
      if (isGameWon(s.score)) {
        s.phase = PHASE.OVER;
        s.winner = ev.p;
        s.games[ev.p] += 1;
      }
      break;
    case 'newGame':
      s.phase = PHASE.CHOOSE_SERVER;
      s.score = [0, 0];
      s.firstServer = null;
      s.server = null;
      s.winner = null;
      s.gameNo += 1;
      break;
  }
  return s;
}

export function deriveState(events) {
  return events.reduce(apply, initialState());
}
