export const SUPABASE_URL =
  "https://avmdsxgqgamhlftlezis.supabase.co";

export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2bWRzeGdxZ2FtaGxmdGxlemlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNjYyNjksImV4cCI6MjEwMzk0MjI2OX0.TlnIWjAq6hTChK4Qm0rFH25yNCcZm5yPGIqUZbqPKEk";

export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export const MATCH_DURATION_SECONDS = 20;
export const CAPTURE_TIMES_SECONDS = [4, 10, 16];

export const AUDIO_TRACKS = [
  "./assets/audio/track-1.mp3",
  "./assets/audio/track-2.mp3",
  "./assets/audio/track-3.mp3",
];

export function isConfigured() {
  return (
    SUPABASE_URL.startsWith("https://") &&
    !SUPABASE_URL.includes("PASTE_") &&
    SUPABASE_ANON_KEY.length > 40 &&
    !SUPABASE_ANON_KEY.includes("PASTE_")
  );
}
