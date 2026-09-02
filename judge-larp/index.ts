import OpenAI from "npm:openai@6.16.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean);

const CAPTURE_SECONDS = [4, 8, 12, 16, 20] as const;
const FRAME_COUNT = CAPTURE_SECONDS.length;

const schema = {
  type: "object", additionalProperties: false, required: ["playerA", "playerB", "timeline", "match_commentary"],
  properties: {
    playerA: { $ref: "#/$defs/player" }, playerB: { $ref: "#/$defs/player" },
    timeline: {
      type: "array", minItems: FRAME_COUNT, maxItems: FRAME_COUNT,
      items: { $ref: "#/$defs/moment" },
    },
    match_commentary: { type: "string", minLength: 1, maxLength: 180 },
  },
  $defs: {
    evidence: {
      type: "object", additionalProperties: false, required: ["label", "observation", "bonus"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 48 },
        observation: { type: "string", minLength: 1, maxLength: 120 },
        bonus: { type: "number", minimum: 0, maximum: 2 },
      },
    },
    moment: {
      type: "object", additionalProperties: false, required: ["second", "playerA", "playerB", "callout"],
      properties: {
        second: { type: "integer", minimum: 4, maximum: 20 },
        playerA: { type: "number", minimum: 0, maximum: 10 },
        playerB: { type: "number", minimum: 0, maximum: 10 },
        callout: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
    player: {
      type: "object", additionalProperties: false,
      required: ["item_larp", "aura", "commitment", "creativity", "evidence", "comment"],
      properties: {
        item_larp: { type: "number", minimum: 0, maximum: 10 }, aura: { type: "number", minimum: 0, maximum: 10 },
        commitment: { type: "number", minimum: 0, maximum: 10 }, creativity: { type: "number", minimum: 0, maximum: 10 },
        evidence: { type: "array", maxItems: 4, items: { $ref: "#/$defs/evidence" } },
        comment: { type: "string", minLength: 1, maxLength: 140 },
      },
    },
  },
} as const;

const refereePrompt = `You are the referee for a satirical competitive game called LARP-OFF.
You receive ten chronological images: Player A at 4, 8, 12, 16, and 20 seconds, then Player B at those same timestamps. The players are trying to out-larp each other by deliberately presenting visible objects, surroundings, props, outfits, setups, vehicles, accessories, or ridiculous flexes during a twenty-second round.

Judge only what is visibly presented and the theatrical presentation. Score both players comparatively from 0.0 to 10.0 in item_larp (visual impact, humor, extravagance, or strength of visible items/settings), aura (confidence, framing, swagger, timing, and theatrical energy), commitment (effort and commitment to the bit), and creativity (originality, humor, and clever use of surroundings).

Create exactly five timeline moments for seconds 4, 8, 12, 16, and 20. At each moment, give each player's cumulative larp strength from 0.0 to 10.0 based on what has been visibly presented up to that point, plus one concise play-by-play callout about the specific visible swing.

Keep the tone funny, exaggerated, internet-native, playful, and concise. Give concrete evidence callouts for visible items that affected scoring. Recognize clearly visible branded logos (for example a Peter Millar logo), cash, sunglasses, luxury-looking props, vehicles, and a banking or account screen as larp material. A clear branded logo or well-presented prop can earn an explicit bonus from 0.0 to 2.0. The four final category scores must already include the effect of every listed evidence bonus; the UI displays those bonuses as an explanation and does not add them a second time. Only name a brand when its logo or name is genuinely legible; do not authenticate it. A banking/account screen may be described generically as financial-screen larp, but never transcribe or repeat account numbers, routing numbers, exact balances, names, addresses, or other private data.

Never infer actual wealth or socioeconomic class, state monetary values, authenticate goods, identify real people, rate attractiveness, or infer sensitive traits (including ethnicity, religion, sexuality, disability, health, or politics). Describe uncertain objects generically. Roast only the visible LARP and presentation, never identity, body, or immutable traits.`;

function originAllowed(origin: string | null) {
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin: string | null) {
  const allowed = originAllowed(origin);
  return {
    "Access-Control-Allow-Origin": allowed && origin ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin", "Content-Type": "application/json",
  };
}

function reply(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

function cleanPlayer(value: Record<string, unknown>) {
  const clamp = (score: unknown) => Math.max(0, Math.min(10, Number(score) || 0));
  return {
    item_larp: clamp(value.item_larp), aura: clamp(value.aura), commitment: clamp(value.commitment), creativity: clamp(value.creativity),
    notable_items: [],
    evidence: Array.isArray(value.evidence) ? value.evidence.slice(0, 4).map((item) => {
      const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { label: String(record.label || "Visible flex").slice(0, 48), observation: String(record.observation || "The oracle noticed.").slice(0, 120), bonus: Math.max(0, Math.min(2, Number(record.bonus) || 0)) };
    }) : [],
    comment: String(value.comment ?? "").slice(0, 140),
  };
}

function cleanTimeline(value: unknown, playerA: ReturnType<typeof cleanPlayer>, playerB: ReturnType<typeof cleanPlayer>) {
  const rows = Array.isArray(value) ? value : [];
  const fallbackA = (playerA.item_larp + playerA.aura + playerA.commitment + playerA.creativity) / 4;
  const fallbackB = (playerB.item_larp + playerB.aura + playerB.commitment + playerB.creativity) / 4;
  return Array.from({ length: FRAME_COUNT }, (_, index) => {
    const row = (rows[index] && typeof rows[index] === "object" ? rows[index] : {}) as Record<string, unknown>;
    const clamp = (score: unknown, fallback: number) => Math.max(0, Math.min(10, Number.isFinite(Number(score)) ? Number(score) : fallback));
    return { second: CAPTURE_SECONDS[index], playerA: clamp(row.playerA, fallbackA), playerB: clamp(row.playerB, fallbackB), callout: String(row.callout || "Aura levels remain under review.").slice(0, 120) };
  });
}

function validateFrame(frame: unknown) {
  if (typeof frame !== "string" || !frame.startsWith("data:image/jpeg;base64,")) throw new Error("Frame must be a JPEG data URL");
  if (frame.length > 350_000) throw new Error("A frame exceeds the 350 KB limit");
  return frame;
}

function validateImages(images: unknown): { playerA: string[]; playerB: string[] } {
  if (!images || typeof images !== "object") throw new Error("Ten JPEG frames are required");
  const record = images as Record<string, unknown>;
  const validateSet = (value: unknown) => {
    if (!Array.isArray(value) || value.length !== FRAME_COUNT) throw new Error(`Exactly ${FRAME_COUNT} frames per player are required`);
    return value.map(validateFrame);
  };
  return { playerA: validateSet(record.playerA), playerB: validateSet(record.playerB) };
}

function parseModelJson(text: string): Record<string, unknown> {
  try { return JSON.parse(text); }
  catch {
    const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("The oracle returned malformed JSON");
    return JSON.parse(text.slice(start, end + 1));
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return originAllowed(origin) ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : reply(origin, { error: "Origin not allowed" }, 403);
  if (request.method !== "POST") return reply(origin, { error: "Method not allowed" }, 405);
  if (!originAllowed(origin)) return reply(origin, { error: "Origin not allowed" }, 403);
  if (!OPENAI_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) return reply(origin, { error: "Server secrets are not configured" }, 500);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 8_500_000) return reply(origin, { error: "Request is too large" }, 413);

  let matchId = "", clientId = "", claimId = "";
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  try {
    const body = await request.json(); matchId = String(body.match_id || ""); clientId = String(body.client_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(matchId) || !/^[0-9a-f-]{36}$/i.test(clientId)) return reply(origin, { error: "Valid match_id and client_id are required" }, 400);
    const images = validateImages(body.images); claimId = crypto.randomUUID();
    const { data: claim, error: claimError } = await supabase.rpc("claim_larp_judging", { p_match_id: matchId, p_client_id: clientId, p_claim_id: claimId });
    if (claimError) throw claimError;
    if (claim?.state === "complete") return reply(origin, { result: claim.result, cached: true });
    if (claim?.state === "forbidden") return reply(origin, { error: "Only Player A may request judging" }, 403);
    if (claim?.state === "not_found") return reply(origin, { error: "Match not found" }, 404);
    if (claim?.state === "busy") return reply(origin, { error: "Judging is already in progress" }, 409);
    if (claim?.state === "attempts_exhausted") return reply(origin, { error: "Judging retry limit reached" }, 429);
    if (claim?.state !== "claimed") return reply(origin, { error: "Match is not ready for judging" }, 409);

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const content: any[] = [{ type: "input_text", text: "Judge this LARP-OFF round. Compare matching timestamps and return the complete five-moment evaluation timeline. Be concise." }];
    for (const [player, frames] of [["A", images.playerA], ["B", images.playerB]] as const) {
      frames.forEach((image, index) => {
        content.push({ type: "input_text", text: `Player ${player} at ${CAPTURE_SECONDS[index]} seconds` });
        content.push({ type: "input_image", image_url: image, detail: "low" });
      });
    }
    const response = await openai.responses.create({
      model: "gpt-4o-mini", instructions: refereePrompt,
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: "larp_off_verdict", strict: true, schema } },
      max_output_tokens: 1600, store: false, safety_identifier: clientId,
    });
    const parsed = parseModelJson(response.output_text);
    const playerA = cleanPlayer((parsed.playerA || {}) as Record<string, unknown>);
    const playerB = cleanPlayer((parsed.playerB || {}) as Record<string, unknown>);
    const result = { playerA, playerB, timeline: cleanTimeline(parsed.timeline, playerA, playerB), match_commentary: String(parsed.match_commentary || "A historic aura collision.").slice(0, 180) };
    const { data: completed, error: completeError } = await supabase.rpc("complete_larp_judging", { p_match_id: matchId, p_claim_id: claimId, p_result: result });
    if (completeError || !completed) throw completeError || new Error("Could not save verdict");
    return reply(origin, { result });
  } catch (error) {
    console.error("judge-larp failed", error);
    if (claimId && matchId) await supabase.rpc("release_larp_judging", { p_match_id: matchId, p_claim_id: claimId });
    return reply(origin, { error: error instanceof Error ? error.message : "Judging failed" }, 500);
  }
});
