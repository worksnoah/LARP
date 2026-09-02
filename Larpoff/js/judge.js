import { getSupabase, fetchMatch } from "./matchmaking.js";

export async function requestJudgment(matchId, clientId, frames) {
  if (frames.playerA.length !== 3 || frames.playerB.length !== 3) throw new Error("The oracle did not receive all six frames.");
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
