import OpenAI from "npm:openai@6.16.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean);

const schema = {
  type: "object", additionalProperties: false, required: ["playerA", "playerB", "match_commentary"],
  properties: {
    playerA: { $ref: "#/$defs/player" }, playerB: { $ref: "#/$defs/player" },
    match_commentary: { type: "string", minLength: 1, maxLength: 180 },
  },
  $defs: { player: {
    type: "object", additionalProperties: false,
    required: ["item_larp", "aura", "commitment", "creativity", "notable_items", "comment"],
    properties: {
      item_larp: { type: "number", minimum: 0, maximum: 10 }, aura: { type: "number", minimum: 0, maximum: 10 },
      commitment: { type: "number", minimum: 0, maximum: 10 }, creativity: { type: "number", minimum: 0, maximum: 10 },
      notable_items: { type: "array", maxItems: 3, items: { type: "string", maxLength: 80 } },
      comment: { type: "string", minLength: 1, maxLength: 140 },
    },
  } },
} as const;

const refereePrompt = `You are the referee for a satirical competitive game called LARP-OFF.
You receive six chronological images: three of Player A, then three of Player B. The players are trying to out-larp each other by deliberately presenting visible objects, surroundings, props, outfits, setups, vehicles, accessories, or ridiculous flexes during a twenty-second round.

Judge only what is visibly presented and the theatrical presentation. Score both players comparatively from 0.0 to 10.0 in item_larp (visual impact, humor, extravagance, or strength of visible items/settings), aura (confidence, framing, swagger, timing, and theatrical energy), commitment (effort and commitment to the bit), and creativity (originality, humor, and clever use of surroundings).

Keep the tone funny, exaggerated, internet-native, playful, and concise. Provide up to three notable visible things per player, one very short playful line per player, and one short match commentary line comparing them.

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
    notable_items: Array.isArray(value.notable_items) ? value.notable_items.slice(0, 3).map((item) => String(item).slice(0, 80)) : [],
    comment: String(value.comment ?? "").slice(0, 140),
  };
}

function validateImages(images: unknown): { playerA: string[]; playerB: string[] } {
  if (!images || typeof images !== "object") throw new Error("Six JPEG frames are required");
  const record = images as Record<string, unknown>;
  const validateSet = (value: unknown) => {
    if (!Array.isArray(value) || value.length !== 3) throw new Error("Exactly three frames per player are required");
    return value.map((frame) => {
      if (typeof frame !== "string" || !frame.startsWith("data:image/jpeg;base64,")) throw new Error("Frames must be JPEG data URLs");
      if (frame.length > 700_000) throw new Error("A frame exceeds the 700 KB limit"); return frame;
    });
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
  if (contentLength > 4_500_000) return reply(origin, { error: "Request is too large" }, 413);

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
    const content: any[] = [{ type: "input_text", text: "Judge this LARP-OFF round. Images 1-3 are Player A; images 4-6 are Player B." }];
    for (const image of [...images.playerA, ...images.playerB]) content.push({ type: "input_image", image_url: image, detail: "low" });
    const response = await openai.responses.create({
      model: "gpt-4o-mini", instructions: refereePrompt,
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: "larp_off_verdict", strict: true, schema } },
      max_output_tokens: 900, store: false, safety_identifier: clientId,
    });
    const parsed = parseModelJson(response.output_text);
    const result = { playerA: cleanPlayer((parsed.playerA || {}) as Record<string, unknown>), playerB: cleanPlayer((parsed.playerB || {}) as Record<string, unknown>), match_commentary: String(parsed.match_commentary || "A historic aura collision.").slice(0, 180) };
    const { data: completed, error: completeError } = await supabase.rpc("complete_larp_judging", { p_match_id: matchId, p_claim_id: claimId, p_result: result });
    if (completeError || !completed) throw completeError || new Error("Could not save verdict");
    return reply(origin, { result });
  } catch (error) {
    console.error("judge-larp failed", error);
    if (claimId && matchId) await supabase.rpc("release_larp_judging", { p_match_id: matchId, p_claim_id: claimId });
    return reply(origin, { error: error instanceof Error ? error.message : "Judging failed" }, 500);
  }
});
