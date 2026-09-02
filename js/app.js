import { AppState, app, getClientId, resetMatchState, transition, updateSession } from "./state.js";
import { CAPTURE_TIMES_SECONDS, isConfigured, MATCH_DURATION_SECONDS } from "./config.js?v=20260902d";
import { initUI, elements, attachLocalStream, attachRemoteStream, setConnecting, renderCountdown, hideCountdown, setTimer, setJudgeStills, renderResult, resetUI, showConfigHint, startLiveEvaluation, updateLiveEvaluation } from "./ui.js?v=20260902d";
import { Matchmaker, getSupabase, updateMatchStatus, abandonMatch } from "./matchmaking.js?v=20260902d";
import { PeerSession } from "./webrtc.js?v=20260902d";
import { BattleAudio } from "./audio.js?v=20260902d";
import { FrameCollector, captureFrame } from "./capture.js?v=20260902d";
import { requestJudgment, waitForPersistedResult } from "./judge.js?v=20260902d";

const audio = new BattleAudio();
let matchmaker = null, collector = null, countdownTimer = null, battleFrame = null, resultPollToken = 0;
let currentErrorAction = null, remoteMediaReady = false, opponentMediaReady = false, judgingInFlight = false, latestPulseSecond = 0;

initUI();
setTimer(MATCH_DURATION_SECONDS);
if (!isConfigured()) showConfigHint("Setup required: add your public Supabase URL and anon key in js/config.js before entering the arena.");
const webMcpLifecycle = new AbortController();
registerWebMcp();

elements.start.addEventListener("click", startExperience);
elements.flee.addEventListener("click", () => exitToHome());
elements.leave.addEventListener("click", () => failMatch("YOU LEFT THE ARENA", "Your camera stays ready if you want another opponent.", "FIND ANOTHER"));
elements.next.addEventListener("click", nextMatch);
elements.exit.addEventListener("click", exitToHome);
elements.errorExit.addEventListener("click", exitToHome);
elements.errorAction.addEventListener("click", () => currentErrorAction?.());
elements.mic.addEventListener("click", toggleMic);
elements.music.addEventListener("click", toggleMusic);

async function startExperience() {
  // Invoke synchronously from the click so mobile Safari accepts the audio
  // unlock, but never let a slow AudioContext resume block the game flow.
  audio.unlockAndPreload().catch(() => {});
  if (!isConfigured()) {
    currentErrorAction = exitToHome;
    transition(AppState.CONFIG_ERROR, { error: { code: "CONFIGURATION REQUIRED", title: "THE PORTAL IS OFFLINE", message: "Paste your Supabase URL and public anon key into js/config.js, then reload the page.", action: "RETURN HOME" } });
    return;
  }
  transition(AppState.REQUESTING_MEDIA);
  try {
    if (!app.localStream?.active) {
      app.localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
    attachLocalStream(app.localStream); await startMatchmaking();
  } catch (error) {
    console.error(error); currentErrorAction = startExperience;
    transition(AppState.PERMISSION_ERROR, { error: { code: "OPTIC LINK REFUSED", title: "CAMERA ACCESS DENIED", message: "Can’t larp if the oracle can’t see and hear you. Allow camera and microphone access, then retry.", action: "RETRY" } });
  }
}

async function startMatchmaking() {
  await cleanupMatch(false); resetMatchState(); resetUI(); attachLocalStream(app.localStream);
  transition(AppState.SEARCHING); const clientId = getClientId();
  matchmaker = new Matchmaker(clientId, {
    onMatch: connectMatch,
    onError: (error) => { console.error(error); showConnectionError("MATCHMAKING SIGNAL LOST", "The arena could not reach Supabase. Check the project configuration and try again."); },
  });
  await matchmaker.start();
}

async function connectMatch(match) {
  app.match = match; transition(AppState.CONNECTING); setConnecting();
  remoteMediaReady = false; opponentMediaReady = false;
  const peer = new PeerSession({
    supabase: getSupabase(), match, clientId: getClientId(), localStream: app.localStream,
    onRemoteStream: handleRemoteStream, onMatchEvent: handleMatchEvent,
    onFailure: (error) => { console.error(error); showConnectionError(); },
    onOpponentLeft: handleOpponentLeft,
  });
  app.peer = peer; await peer.connect();
}

async function handleRemoteStream(stream) {
  await attachRemoteStream(stream);
  const video = elements.remoteVideo;
  if (video.readyState < 2) await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
  remoteMediaReady = true; await app.peer?.broadcast("media-ready"); maybeCoordinateStart();
}

function handleMatchEvent(event) {
  if (!event || event.sender === getClientId()) return;
  if (event.type === "media-ready") { opponentMediaReady = true; maybeCoordinateStart(); }
  if (event.type === "match-start") scheduleMatch(event);
  if (event.type === "live-eval" && event.pulse) applyLiveEvaluation(event.pulse);
  if (event.type === "judge-result" && event.result) finishWithResult(event.result);
  if (event.type === "opponent-left") handleOpponentLeft();
}

async function maybeCoordinateStart() {
  if (!app.peer?.isPlayerA || !remoteMediaReady || !opponentMediaReady || app.countdownStarted) return;
  const event = { type: "match-start", startAt: Date.now() + 3800, startDelayMs: 3800, duration: MATCH_DURATION_SECONDS, trackIndex: app.match.track_index };
  await updateMatchStatus(app.match.id, getClientId(), "countdown").catch(() => {});
  await app.peer.broadcast(event.type, event); scheduleMatch(event);
  // A duplicate is harmless (scheduleMatch is idempotent) and covers a client
  // resubscription on the exact frame the first event was broadcast.
  setTimeout(() => app.peer?.broadcast(event.type, event).catch(() => {}), 550);
}

function scheduleMatch(event) {
  if (app.countdownStarted || !app.match) return; app.countdownStarted = true;
  // Player B schedules from the received delay to tolerate inaccurate device
  // clocks; Player A retains its exact local timestamp. Network latency is
  // usually small compared with the 3.8 second countdown runway.
  const startAt = app.peer?.isPlayerA
    ? (Number(event.startAt) || Date.now() + 3800)
    : Date.now() + Math.max(1200, Number(event.startDelayMs) || 3800);
  transition(AppState.COUNTDOWN);
  let rendered = "";
  const update = () => {
    const remaining = startAt - Date.now();
    if (remaining <= 0) { clearInterval(countdownTimer); renderCountdown("LARP"); setTimeout(hideCountdown, 420); beginBattle(startAt, event.duration, event.trackIndex); return; }
    const label = String(Math.min(3, Math.max(1, Math.ceil(remaining / 1000)))); if (label !== rendered) { rendered = label; renderCountdown(label); }
  };
  update(); countdownTimer = setInterval(update, 50);
}

function beginBattle(startAt, duration = MATCH_DURATION_SECONDS, trackIndex = app.match?.track_index) {
  if (app.battleStarted || !app.match) return; app.battleStarted = true; transition(AppState.BATTLE);
  latestPulseSecond = 0; startLiveEvaluation();
  const elapsed = Math.max(0, (Date.now() - startAt) / 1000); audio.play(trackIndex, elapsed);
  if (app.peer?.isPlayerA) {
    collector = new FrameCollector(elements.localVideo, elements.remoteVideo); app.frames = collector.frames; collector.start(scoreCapturedFrame);
    updateMatchStatus(app.match.id, getClientId(), "battle").catch(() => {});
  }
  const endAt = startAt + duration * 1000;
  const tick = () => {
    if (!app.battleStarted || app.current !== AppState.BATTLE) return;
    const seconds = Math.max(0, (endAt - Date.now()) / 1000); setTimer(seconds);
    if (seconds <= 0) endBattle(); else battleFrame = requestAnimationFrame(tick);
  };
  tick();
}

function scoreCapturedFrame(_second, _frames, pulse) {
  if (!app.peer?.isPlayerA || !app.match) return;
  applyLiveEvaluation(pulse); app.peer.broadcast("live-eval", { pulse }).catch(() => {});
}

function applyLiveEvaluation(pulse) {
  const second = Number(pulse?.second) || 0;
  if (second < latestPulseSecond || !app.peer) return;
  latestPulseSecond = second; updateLiveEvaluation(pulse, app.peer.isPlayerA);
}

async function endBattle() {
  if (!app.battleStarted) return; app.battleStarted = false; cancelAnimationFrame(battleFrame); setTimer(0); audio.fadeOut(1);
  const frames = collector?.stop() || app.frames;
  if (app.peer?.isPlayerA && frames) {
    try {
      const expected = CAPTURE_TIMES_SECONDS.length;
      while (frames.playerA.length < expected) frames.playerA.push(captureFrame(elements.localVideo));
      while (frames.playerB.length < expected) frames.playerB.push(captureFrame(elements.remoteVideo));
    } catch {}
  }
  const lastA = app.peer?.isPlayerA ? frames?.playerA.at(-1) : safeCapture(elements.localVideo);
  const lastB = app.peer?.isPlayerA ? frames?.playerB.at(-1) : safeCapture(elements.remoteVideo);
  setJudgeStills(lastA, lastB); transition(AppState.JUDGING);
  if (app.peer?.isPlayerA) { await updateMatchStatus(app.match.id, getClientId(), "judging").catch(() => {}); judgeAsCoordinator(); }
  else waitForResult();
}

function safeCapture(video) { try { return captureFrame(video, 960, .65); } catch { return null; } }

async function judgeAsCoordinator() {
  if (judgingInFlight || !app.frames || !app.match) return; judgingInFlight = true;
  try {
    const result = await requestJudgment(app.match.id, getClientId(), app.frames); app.frames = null; collector?.clear(); collector = null;
    await app.peer?.broadcast("judge-result", { result }); finishWithResult(result);
  } catch (error) {
    console.error(error); currentErrorAction = () => { transition(AppState.JUDGING); judgeAsCoordinator(); };
    transition(AppState.CONNECTION_ERROR, { error: { code: "ORACLE PROCESS FAILURE", title: "THE ORACLE CHOKED", message: error.message || "AI judging failed. Your round frames remain ready for another attempt.", action: "RETRY JUDGING" } });
  } finally { judgingInFlight = false; }
}

async function waitForResult() {
  const token = ++resultPollToken;
  try { const result = await waitForPersistedResult(app.match.id, getClientId()); if (token === resultPollToken && !app.result) finishWithResult(result); }
  catch (error) { if (token === resultPollToken) { console.error(error); currentErrorAction = waitForResult; transition(AppState.CONNECTION_ERROR, { error: { code: "ORACLE SIGNAL LOST", title: "THE ORACLE CHOKED", message: "The verdict did not arrive. Ask the oracle to check the match record again.", action: "CHECK AGAIN" } }); } }
}

function finishWithResult(result) {
  if (app.result || !app.match) return; app.result = result; resultPollToken += 1; transition(AppState.RESULT);
  renderResult(result, app.match, getClientId(), updateSession);
}

function toggleMic() {
  const track = app.localStream?.getAudioTracks()[0]; if (!track) return; track.enabled = !track.enabled;
  elements.mic.setAttribute("aria-pressed", String(!track.enabled)); elements.mic.setAttribute("aria-label", track.enabled ? "Mute microphone" : "Unmute microphone");
}

function toggleMusic() {
  audio.setMuted(!audio.muted); elements.music.setAttribute("aria-pressed", String(audio.muted));
  elements.music.setAttribute("aria-label", audio.muted ? "Unmute battle music" : "Mute battle music");
}

async function handleOpponentLeft() {
  if ([AppState.RESULT, AppState.HOME].includes(app.current)) return;
  audio.fadeOut(.4); app.battleStarted = false; currentErrorAction = requeueAfterAbandon;
  if (app.match) abandonMatch(app.match.id, getClientId()).catch(() => {});
  transition(AppState.CONNECTION_ERROR, { error: { code: "REMOTE AURA COLLAPSE", title: app.current === AppState.BATTLE ? "OPPONENT FLED THE LARP" : "OPPONENT VANISHED", message: "Their aura couldn’t handle it. The queue remains hungry.", action: "FIND ANOTHER" } });
}

function showConnectionError(title = "LARP CONNECTION LOST", message = "The larpverse has rejected this match. STUN-only connections can fail on restrictive networks.") {
  app.battleStarted = false; audio.fadeOut(.4); currentErrorAction = requeueAfterAbandon;
  if (app.match) abandonMatch(app.match.id, getClientId()).catch(() => {});
  transition(AppState.CONNECTION_ERROR, { error: { code: "PEER LINK FAILURE", title, message, action: "FIND ANOTHER" } });
}

async function failMatch(title, message, action) {
  if (app.match) { await app.peer?.broadcast("opponent-left").catch(() => {}); await abandonMatch(app.match.id, getClientId()).catch(() => {}); }
  await cleanupMatch(false); currentErrorAction = startMatchmaking;
  transition(AppState.CONNECTION_ERROR, { error: { code: "MATCH TERMINATED", title, message, action } });
}

async function nextMatch() {
  audio.unlockAndPreload().catch(() => {});
  await cleanupMatch(false); await startMatchmaking();
}

async function requeueAfterAbandon() {
  if (app.match) await abandonMatch(app.match.id, getClientId()).catch(() => {});
  await startMatchmaking();
}

async function exitToHome() {
  await matchmaker?.stop(true); matchmaker = null;
  if (app.match && app.current !== AppState.RESULT) { await app.peer?.broadcast("opponent-left").catch(() => {}); await abandonMatch(app.match.id, getClientId()).catch(() => {}); }
  await cleanupMatch(false); stopLocalMedia(); resetMatchState(); resetUI(); transition(AppState.HOME);
}

async function cleanupMatch(notify = false) {
  clearInterval(countdownTimer); cancelAnimationFrame(battleFrame); resultPollToken += 1; app.battleStarted = false;
  collector?.clear(); collector = null; audio.stopImmediately(); await matchmaker?.stop(true); matchmaker = null;
  await app.peer?.close({ notify }).catch(() => {}); app.peer = null; elements.remoteVideo.srcObject = null;
  remoteMediaReady = false; opponentMediaReady = false; judgingInFlight = false;
}

function stopLocalMedia() {
  app.localStream?.getTracks().forEach((track) => track.stop()); app.localStream = null;
  elements.localVideo.srcObject = null; elements.searchVideo.srcObject = null;
}

window.addEventListener("pagehide", () => {
  webMcpLifecycle.abort();
  if (app.match) app.peer?.broadcast("opponent-left").catch(() => {});
  app.peer?.close().catch(() => {}); app.localStream?.getTracks().forEach((track) => track.stop());
});

function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const options = { signal: webMcpLifecycle.signal };
  const report = (error) => console.warn("WebMCP registration failed", error);
  try {
    Promise.resolve(context.registerTool({
      name: "read_larp_off_state", title: "Read LARP-OFF state",
      description: "Read the current visible arena state and whether this deployment is configured.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({ state: app.current, configured: isConfigured(), inMatch: Boolean(app.match) }),
    }, options)).catch(report);
    Promise.resolve(context.registerTool({
      name: "start_larp_off", title: "Start LARP-OFF",
      description: "Trigger the same START LARP-OFF action as the visible button. This may request camera and microphone permission before entering matchmaking.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute() {
        if (app.current !== AppState.HOME) throw new Error(`Cannot start from ${app.current}`);
        await startExperience(); return { state: app.current, configured: isConfigured() };
      },
    }, options)).catch(report);
  } catch (error) { report(error); }
}
