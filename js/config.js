export const SUPABASE_URL = "PASTE_SUPABASE_URL_HERE";
export const SUPABASE_ANON_KEY = "";

export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export const MATCH_DURATION_SECONDS = 20;
// One frame from each player every two seconds for the full round.
export const CAPTURE_TIMES_SECONDS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
export const AUDIO_TRACKS = [
  "./assets/audio/track-1.mp3",
  "./assets/audio/track-2.mp3",
  "./assets/audio/track-3.mp3",
];

export function isConfigured() {
  return SUPABASE_URL.startsWith("https://") &&
    !SUPABASE_URL.includes("PASTE_") &&
    SUPABASE_ANON_KEY.length > 40 &&
    !SUPABASE_ANON_KEY.includes("PASTE_");
}
