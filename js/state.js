export const AppState = Object.freeze({
  HOME: "HOME", REQUESTING_MEDIA: "REQUESTING_MEDIA", SEARCHING: "SEARCHING",
  CONNECTING: "CONNECTING", COUNTDOWN: "COUNTDOWN", BATTLE: "BATTLE",
  JUDGING: "JUDGING", RESULT: "RESULT", CONNECTION_ERROR: "CONNECTION_ERROR",
  PERMISSION_ERROR: "PERMISSION_ERROR", CONFIG_ERROR: "CONFIG_ERROR",
});

const SESSION_KEY = "larpoff_session_stats";
const defaultStats = { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, points: 0 };

function loadStats() {
  try { return { ...defaultStats, ...JSON.parse(sessionStorage.getItem(SESSION_KEY) || "{}") }; }
  catch { return { ...defaultStats }; }
}

export const app = {
  current: AppState.HOME, localStream: null, match: null, peer: null, frames: null,
  result: null, countdownStarted: false, battleStarted: false, stats: loadStats(),
};

const listeners = new Set();
export function onStateChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function transition(next, detail = {}) {
  const previous = app.current;
  app.current = next;
  for (const listener of listeners) listener({ previous, next, detail });
}
export function resetMatchState() {
  app.match = null; app.peer = null; app.frames = null; app.result = null;
  app.countdownStarted = false; app.battleStarted = false;
}
export function getClientId() {
  let id = sessionStorage.getItem("client_id");
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem("client_id", id); }
  return id;
}
export function updateSession(outcome, yourScore, theirScore) {
  const margin = Math.abs(yourScore - theirScore);
  const winnerGain = Math.round(75 + Math.max(yourScore, theirScore) * 12 + margin * 35);
  let change = 0;
  if (outcome === "win") {
    app.stats.wins += 1; app.stats.currentStreak += 1;
    app.stats.bestStreak = Math.max(app.stats.bestStreak, app.stats.currentStreak); change = winnerGain;
  } else if (outcome === "loss") {
    app.stats.losses += 1; app.stats.currentStreak = 0; change = -Math.round(winnerGain * .25);
  } else { app.stats.currentStreak = 0; change = 10; }
  app.stats.points = Math.max(0, app.stats.points + change);
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(app.stats));
  return change;
}
