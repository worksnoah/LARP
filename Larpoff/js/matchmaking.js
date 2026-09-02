import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

let client = null;
export function getSupabase() {
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  return client;
}

const descriptor = (row) => row && ({
  id: row.match_id, player_a: row.player_a, player_b: row.player_b,
  track_index: Number(row.track_index), status: row.match_status || row.status, result: row.result || null,
});

export class Matchmaker {
  constructor(clientId, { onMatch, onError }) {
    this.clientId = clientId; this.onMatch = onMatch; this.onError = onError;
    this.supabase = getSupabase(); this.stopped = false; this.pollTimer = null; this.heartbeatTimer = null;
  }

  async start() {
    this.stopped = false;
    try {
      const { data, error } = await this.supabase.rpc("join_larp_queue", { p_client_id: this.clientId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.match_id) return this.found(descriptor(row));
      this.pollTimer = setInterval(() => this.poll(), 1000);
      this.heartbeatTimer = setInterval(() => this.heartbeat(), 9000);
    } catch (error) { this.fail(error); }
  }

  async poll() {
    if (this.stopped) return;
    try {
      const { data, error } = await this.supabase.rpc("check_larp_match", { p_client_id: this.clientId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.match_id) this.found(descriptor(row));
    } catch (error) { this.fail(error); }
  }

  async heartbeat() {
    if (this.stopped) return;
    const { error } = await this.supabase.rpc("heartbeat_larp_queue", { p_client_id: this.clientId });
    if (error) this.fail(error);
  }

  found(match) { if (this.stopped) return; this.stop(false); this.onMatch(match); }
  fail(error) { if (this.stopped) return; this.stop(false); this.onError(error); }

  async stop(removeFromQueue = true) {
    this.stopped = true; clearInterval(this.pollTimer); clearInterval(this.heartbeatTimer);
    this.pollTimer = null; this.heartbeatTimer = null;
    if (removeFromQueue) {
      try { await this.supabase.rpc("leave_larp_queue", { p_client_id: this.clientId }); } catch {}
    }
  }
}

export async function updateMatchStatus(matchId, clientId, status) {
  return getSupabase().rpc("update_larp_match_status", { p_match_id: matchId, p_client_id: clientId, p_status: status });
}

export async function abandonMatch(matchId, clientId) {
  return getSupabase().rpc("abandon_larp_match", { p_match_id: matchId, p_client_id: clientId });
}

export async function fetchMatch(matchId, clientId) {
  const { data, error } = await getSupabase().rpc("get_larp_match", { p_match_id: matchId, p_client_id: clientId });
  if (error) throw error; const row = Array.isArray(data) ? data[0] : data; return descriptor(row);
}
