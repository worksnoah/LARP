import { getSupabase, fetchMatch } from "./matchmaking.js?v=20260902d";
import { CAPTURE_TIMES_SECONDS } from "./config.js?v=20260902d";

export async function requestJudgment(matchId, clientId, frames) {
  const expected = CAPTURE_TIMES_SECONDS.length;
  if (frames.playerA.length !== expected || frames.playerB.length !== expected) throw new Error(`The oracle needs all ${expected * 2} frames.`);
  const { data, error } = await getSupabase().functions.invoke("judge-larp", {
    body: { match_id: matchId, client_id: clientId, images: frames },
  });
  if (error) throw new Error(error.context?.body?.message || error.message || "AI judging failed");
  if (!data?.result) throw new Error("The oracle returned no verdict."); return data.result;
}

export function waitForPersistedResult(matchId, clientId, { timeoutMs = 55000, intervalMs = 1800 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      try {
        const match = await fetchMatch(matchId, clientId); if (match?.result) return resolve(match.result);
        if (match?.status === "abandoned") return reject(new Error("Opponent left"));
      } catch {}
      if (Date.now() - started >= timeoutMs) return reject(new Error("Judging timed out"));
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}
