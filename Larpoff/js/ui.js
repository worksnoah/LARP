import { AppState, app, onStateChange } from "./state.js";

const $ = (selector) => document.querySelector(selector);
const screens = {
  [AppState.HOME]: $("#screen-home"), [AppState.REQUESTING_MEDIA]: $("#screen-requesting"),
  [AppState.SEARCHING]: $("#screen-searching"), [AppState.CONNECTING]: $("#screen-arena"),
  [AppState.COUNTDOWN]: $("#screen-arena"), [AppState.BATTLE]: $("#screen-arena"),
  [AppState.JUDGING]: $("#screen-judging"), [AppState.RESULT]: $("#screen-result"),
  [AppState.CONNECTION_ERROR]: $("#screen-error"), [AppState.PERMISSION_ERROR]: $("#screen-error"),
  [AppState.CONFIG_ERROR]: $("#screen-error"),
};

const searchPhrases = ["Scanning the larpverse...", "Looking for a worthy opponent...", "Measuring global aura...", "Locating flex signal..."];
const judgePhrases = ["Scanning assets...", "Measuring aura...", "Calculating larp pressure...", "Verifying flex...", "Assessing commitment...", "Consulting the oracle..."];
let phraseTimer = null;

export const elements = {
  start: $("#start-button"), flee: $("#flee-button"), leave: $("#leave-button"),
  mic: $("#mic-button"), music: $("#music-button"), next: $("#next-button"), exit: $("#exit-button"),
  errorAction: $("#error-action"), errorExit: $("#error-exit"), localVideo: $("#local-video"),
  remoteVideo: $("#remote-video"), searchVideo: $("#search-video"),
};

function activateScreen(state) {
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("is-active"));
  screens[state]?.classList.add("is-active");
  $("#app").dataset.state = state;
  clearInterval(phraseTimer); phraseTimer = null;
  if (state === AppState.SEARCHING) cycleText($("#search-phrase"), searchPhrases, 1900);
  if (state === AppState.JUDGING) cycleText($("#judge-phrase"), judgePhrases, 700);
}

function cycleText(node, phrases, delay) {
  let index = 0; node.textContent = phrases[0];
  phraseTimer = setInterval(() => { index = (index + 1) % phrases.length; node.textContent = phrases[index]; }, delay);
}

export function initUI() { onStateChange(({ next, detail }) => { activateScreen(next); if (detail.error) showError(detail.error); }); }

export function attachLocalStream(stream) {
  elements.localVideo.srcObject = stream; elements.searchVideo.srcObject = stream;
  elements.localVideo.play().catch(() => {}); elements.searchVideo.play().catch(() => {});
}

export function attachRemoteStream(stream) {
  elements.remoteVideo.srcObject = stream;
  return elements.remoteVideo.play().catch(() => {});
}

export function setConnecting() {
  $("#countdown-overlay").classList.add("is-visible");
  $("#countdown-text").className = ""; $("#countdown-text").textContent = "OPPONENT ACQUIRED";
  $("#battle-message").textContent = "Flex signal locked";
}

export function renderCountdown(value) {
  const overlay = $("#countdown-overlay"); const text = $("#countdown-text");
  overlay.classList.add("is-visible"); text.className = value === "LARP" ? "is-larp" : "";
  text.textContent = value; text.style.animation = "none"; void text.offsetWidth; text.style.animation = "";
}

export function hideCountdown() { $("#countdown-overlay").classList.remove("is-visible"); $("#battle-message").textContent = "Larp for your life"; }

export function setTimer(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  $("#battle-timer strong").textContent = `00:${String(safe).padStart(2, "0")}`;
  $("#battle-timer").classList.toggle("is-urgent", safe <= 5 && safe > 0);
  $("#screen-arena").classList.toggle("is-final-five", safe <= 5 && safe > 0);
}

export function setJudgeStills(frameA, frameB) {
  if (frameA) $("#judge-still-a").style.backgroundImage = `url(${frameA})`;
  if (frameB) $("#judge-still-b").style.backgroundImage = `url(${frameB})`;
}

export function showError({ code = "ARENA FAULT", title, message, action = "FIND ANOTHER" }) {
  $("#error-code").textContent = code; $("#error-title").textContent = title;
  $("#error-message").textContent = message; elements.errorAction.textContent = action;
}

export function showConfigHint(message) { const note = $("#config-note"); note.hidden = false; note.textContent = message; }

const weightedScore = (player) => Math.round((player.item_larp * .4 + player.aura * .25 + player.commitment * .2 + player.creativity * .15) * 10) / 10;
export function getRank(score) {
  if (score >= 9.7) return "LARP GOD"; if (score >= 9.1) return "LARP LEGEND";
  if (score >= 8.2) return "FINAL BOSS"; if (score >= 7) return "BOSS";
  if (score >= 5.5) return "CAPTAIN"; if (score >= 4) return "HUSTLER";
  if (score >= 2.5) return "PROSPECT"; return "NPC";
}

function rankClass(rank) { return rank === "LARP GOD" ? "rank rank--god" : ["FINAL BOSS", "LARP LEGEND"].includes(rank) ? "rank rank--elite" : "rank"; }

export function normalizeResult(raw) {
  const clamp = (value) => Math.max(0, Math.min(10, Number(value) || 0));
  const player = (value = {}) => ({
    item_larp: clamp(value.item_larp), aura: clamp(value.aura), commitment: clamp(value.commitment), creativity: clamp(value.creativity),
    notable_items: Array.isArray(value.notable_items) ? value.notable_items.slice(0, 3).map(String) : [], comment: String(value.comment || "The oracle remains mysteriously impressed."),
  });
  return { playerA: player(raw?.playerA), playerB: player(raw?.playerB), match_commentary: String(raw?.match_commentary || "A historic collision of incompatible aura.") };
}

export function renderResult(raw, match, clientId, updateStats) {
  const result = normalizeResult(raw); const youAreA = match.player_a === clientId;
  const you = youAreA ? result.playerA : result.playerB; const them = youAreA ? result.playerB : result.playerA;
  const yourTotal = weightedScore(you); const theirTotal = weightedScore(them); const difference = yourTotal - theirTotal;
  const outcome = difference > .15 ? "win" : difference < -.15 ? "loss" : "tie";
  const headline = outcome === "win" ? "YOU LARPED THEM" : outcome === "loss" ? "YOU GOT LARPED" : "LARP STALEMATE";
  const screen = $("#screen-result"); screen.dataset.outcome = outcome; $("#result-headline").textContent = headline;
  $("#match-commentary").textContent = `“${result.match_commentary}”`;
  $("#your-score").textContent = "0.0"; $("#their-score").textContent = "0.0";
  const yourRank = getRank(yourTotal), theirRank = getRank(theirTotal);
  $("#your-rank").textContent = yourRank; $("#your-rank").className = rankClass(yourRank);
  $("#their-rank").textContent = theirRank; $("#their-rank").className = rankClass(theirRank);
  $("#your-comment").textContent = you.comment; $("#their-comment").textContent = them.comment;
  $("#your-score-card").classList.toggle("is-winner", outcome === "win"); $("#their-score-card").classList.toggle("is-winner", outcome === "loss");
  const labels = [["item_larp", "Item larp"], ["aura", "Aura"], ["commitment", "Commitment"], ["creativity", "Creativity"]];
  $("#category-board").innerHTML = labels.flatMap(([key, label]) => [
    `<div class="category-row is-you"><span class="category-name">${label} · You</span><i class="category-track"><b class="category-fill" data-width="${you[key] * 10}"></b></i><span class="category-value">${you[key].toFixed(1)}</span></div>`,
    `<div class="category-row"><span class="category-name">${label} · Them</span><i class="category-track"><b class="category-fill" data-width="${them[key] * 10}"></b></i><span class="category-value">${them[key].toFixed(1)}</span></div>`,
  ]).join("");
  const change = updateStats(outcome, yourTotal, theirTotal);
  $("#points-change").textContent = `${change >= 0 ? "+" : ""}${change} LARP`;
  $("#streak-display").textContent = app.stats.currentStreak > 0 ? `🔥 ${app.stats.currentStreak} WIN STREAK` : `${app.stats.wins}W / ${app.stats.losses}L`;
  $("#session-total").textContent = `Session bank: ${app.stats.points} · Best streak: ${app.stats.bestStreak}`;
  requestAnimationFrame(() => document.querySelectorAll(".category-fill").forEach((bar) => { bar.style.width = `${bar.dataset.width}%`; }));
  animateNumber($("#your-score"), yourTotal); animateNumber($("#their-score"), theirTotal);
  return { result, outcome, yourTotal, theirTotal };
}

function animateNumber(node, target) {
  const started = performance.now(); const duration = 650;
  const tick = (now) => { const p = Math.min(1, (now - started) / duration); node.textContent = (target * (1 - (1 - p) ** 3)).toFixed(1); if (p < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

export function resetUI() {
  elements.remoteVideo.srcObject = null; $("#screen-arena").classList.remove("is-final-five");
  $("#battle-timer").classList.remove("is-urgent"); setTimer(20); hideCountdown();
  $("#judge-still-a").style.backgroundImage = ""; $("#judge-still-b").style.backgroundImage = "";
}
