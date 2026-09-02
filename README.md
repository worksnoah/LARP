# LARP-OFF

LARP-OFF is a friends-only, anonymous 1v1 video game in which two people get 20 seconds to out-larp each other. WebRTC carries live camera and microphone media directly between peers. Supabase handles temporary matchmaking and signaling. At the bell, Player A sends twenty compressed still frames—ten per player—to a protected Supabase Edge Function, which asks `gpt-4o-mini` for one comparative verdict and a 10-step evaluation timeline.

No accounts, chat, recordings, permanent image storage, frontend build, or custom server are involved.

## Architecture

```text
┌──────────────────┐     Supabase RPC      ┌───────────────────────┐
│ Browser: Player A│◄─────────────────────►│ Postgres              │
│ GitHub Pages     │                       │ queue + temp matches  │
└────────┬─────────┘                       └───────────┬───────────┘
         │                                             │
         │  WebRTC video + audio (peer to peer)        │ stored verdict
         │  Supabase Realtime (signaling/events only)  │
         ▼                                             ▼
┌──────────────────┐                       ┌───────────────────────┐
│ Browser: Player B│                       │ Edge: judge-larp      │
│ GitHub Pages     │                       │ 20 JPEGs → OpenAI    │
└──────────────────┘                       └───────────────────────┘
```

Player A is deterministic: the oldest waiting visitor is Player A, creates the WebRTC offer, schedules the shared start time, captures both feeds every two seconds from 2 through 20 seconds, and makes the only judging request. Player B receives the verdict by Realtime Broadcast and polls the temporary match record as a fallback.

## Repository

```text
index.html                    Complete single-page game UI
css/styles.css                Responsive arena, animation, and error styling
js/config.js                  Public Supabase config, ICE, audio, timing
js/app.js                     State-machine orchestration and cleanup
js/state.js                   App/session state and points
js/ui.js                      Rendering and result/rank calculations
js/matchmaking.js             Atomic RPC queue client
js/webrtc.js                  P2P media and Realtime signaling
js/audio.js                   Mobile-safe Web Audio music system
js/capture.js                 Twenty resized in-memory JPEG frames
js/judge.js                   Edge Function request and result recovery
assets/audio/                 Your MP3s (not supplied)
supabase/migrations/          Database schema and protected RPCs
supabase/functions/judge-larp Secure OpenAI referee
```

## 1. Create and configure Supabase

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), create a Supabase project, and sign in:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Apply the migration:

```bash
supabase db push
```

Alternatively, paste the complete contents of `supabase/migrations/001_larpoff.sql` into **Supabase Dashboard → SQL Editor → New query**, then run it once.

The migration creates only temporary queue/match data, enables RLS, denies direct anonymous table access, and exposes narrowly scoped `security definer` RPCs. Matchmaking is serialized with a Postgres advisory transaction lock so two callers cannot claim the same waiting player.

## 2. Configure server secrets

Set the OpenAI key only on Supabase. Never paste it into `js/config.js`, GitHub, or browser code.

```bash
supabase secrets set OPENAI_API_KEY=YOUR_OPENAI_API_KEY
```

Allow the exact origins that may call the judge. Use comma-separated origins with no trailing slash:

```bash
supabase secrets set ALLOWED_ORIGINS="http://localhost:8000,https://YOUR_GITHUB_USERNAME.github.io,https://YOUR_CUSTOM_DOMAIN"
```

Local `http://localhost:any-port` and `http://127.0.0.1:any-port` are accepted automatically. Add your GitHub Pages origin (the origin does not include `/repository-name`) and eventual custom-domain origin explicitly. The function rejects other browser origins.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are built-in Edge Function environment variables on hosted Supabase. If you self-host functions, provide them server-side. The service-role key must never enter frontend code.

Deploy the function with normal JWT verification enabled:

```bash
supabase functions deploy judge-larp
```

The browser invokes it with the public Supabase anon JWT. The function then uses the server-only service role to atomically claim the match, verifies the caller is Player A, limits payload/image sizes, permits at most three attempts, calls OpenAI once, and stores the verdict.

The referee uses the current OpenAI Responses API with image inputs and strict JSON Schema Structured Outputs. The explicitly requested `gpt-4o-mini` supports image inputs, the Responses endpoint, and Structured Outputs according to [official OpenAI documentation](https://developers.openai.com/api/docs/models/gpt-4o-mini).

## 3. Configure the public frontend

Open `js/config.js` and replace only these two values:

```js
export const SUPABASE_URL = "PASTE_SUPABASE_URL_HERE";
export const SUPABASE_ANON_KEY = "PASTE_SUPABASE_ANON_KEY_HERE";
```

Find them under **Supabase Dashboard → Project Settings → API**. These two values are designed to be public; database RLS/RPC boundaries protect the tables. There must be no `OPENAI_API_KEY` in this file.

Configuration checklist:

```text
SUPABASE_URL:
____________________________________

SUPABASE_ANON_KEY:
____________________________________

OPENAI_API_KEY stored as Supabase secret:
____________________________________

Potential future custom domain:
____________________________________
```

## 4. Add battle music

Use music you created or are licensed to distribute. Put the files here:

```text
assets/audio/track-1.mp3
assets/audio/track-2.mp3
assets/audio/track-3.mp3   (optional)
```

Track checklist:

```text
MP3 #1:
____________________________________

MP3 #2:
____________________________________

MP3 #3 OPTIONAL:
____________________________________
```

Missing or undecodable tracks fail silently and never stop a match. The chosen track number is stored on the match and played locally by both devices at the coordinated start; music is never sent through WebRTC. For best results, make tracks longer than 20 seconds and normalize them to similar perceived loudness.

## 5. Test locally

Camera/microphone APIs require a secure context. Browsers treat `localhost` as secure, so do not open `index.html` directly from disk. From the repo root:

```bash
python3 -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000). A phone cannot use your computer's plain HTTP LAN address for camera access. For phone testing, deploy to GitHub Pages first or use an HTTPS tunnel you trust.

### Test with two sessions

Use two separate browsers, browser profiles, or devices so each gets a different `sessionStorage` client ID. Then:

1. Open the same HTTPS URL in both.
2. Press **START LARP-OFF** on each.
3. Allow camera and microphone on both devices.
4. Verify each local preview is mirrored and the remote feed is not.
5. Confirm one match row is created, both devices show the same countdown/track, and both reach results.
6. Press **NEXT LARP** and confirm neither device asks for camera access again.

For debugging only, inspect temporary state in Supabase:

```sql
select * from public.waiting_queue order by joined_at;
select id, player_a, player_b, track_index, status, judge_attempts, result, created_at
from public.matches order by created_at desc limit 20;
```

Do not expose direct table grants just to debug the browser. Use the SQL editor.

## 6. Deploy to GitHub Pages

No build or routing setup is required. Every site-owned URL is relative, so the same files work at `username.github.io/repository-name/` and on a custom domain.

1. Push the repository to GitHub with `index.html` at the repository root.
2. Open **Repository → Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Choose branch **main**, folder **/ (root)**, then **Save**.
5. Wait for the Pages deployment and open the HTTPS URL GitHub shows.
6. Add `https://YOUR_GITHUB_USERNAME.github.io` to the Edge Function's `ALLOWED_ORIGINS` secret, then redeploy the function if you changed secrets.

GitHub Pages serves HTTPS, which is required for camera and microphone access outside localhost.

### Add a custom domain later

In **Repository → Settings → Pages → Custom domain**, enter the domain and follow GitHub's DNS instructions. Enable **Enforce HTTPS** after DNS is active. Add the exact `https://your-domain.example` origin to `ALLOWED_ORIGINS`. Do not add a leading `/` to any asset path; the existing relative paths work unchanged.

## WebRTC notes

Video and microphone tracks travel directly between peers. Supabase Realtime carries only `peer-ready`, SDP offer/answer, ICE candidates, match timing, departure, and verdict events on a channel containing the hard-to-guess match UUID.

`js/config.js` centralizes `ICE_SERVERS`. V1 uses public STUN servers only. That is intentionally lightweight, but peers behind restrictive enterprise, carrier-grade NAT, symmetric NAT, VPN, or firewall configurations may fail to connect. Production reliability across all networks eventually requires a TURN service; add its URLs and credentials to `ICE_SERVERS` without changing the peer logic.

## Troubleshooting

### Camera or microphone denied

- Use HTTPS or `http://localhost`, not `file://` or a plain LAN IP.
- In browser/site settings, allow both camera and microphone, then press **RETRY**.
- On iPhone: **Settings → Apps → Safari → Camera/Microphone** and check per-site settings from Safari's page menu.
- Close other apps that exclusively hold the camera and reload.

### iPhone music is silent

- Press **START LARP-OFF** yourself; Web Audio must be unlocked by a real gesture.
- Check the in-game **MUSIC** toggle and device output volume.
- Confirm the MP3 exists with the exact lowercase filename and is a Safari-compatible MP3.
- Music failure never affects microphone or the match.

### Players never pair

- Confirm the SQL migration ran and the RPC functions exist.
- Verify both browsers use the same Supabase URL/project and different session/client IDs.
- Inspect `waiting_queue`; entries older than 30 seconds are intentionally removed.
- Check the browser console for an RPC error without granting direct table access.

### Video connection fails

- Try disabling VPNs or restrictive content filters and test once on different networks.
- Confirm Supabase Realtime is reachable and neither browser suspended the tab during setup.
- STUN-only V1 cannot traverse every NAT/firewall. Add TURN for broad reliability.
- Make sure both devices granted microphone as well as camera access.

### Supabase/CORS errors

- `ALLOWED_ORIGINS` contains origins only: scheme + hostname + optional port, no path or trailing slash.
- For a Pages project URL, allow `https://username.github.io`, not the `/repository-name` path.
- Redeploy `judge-larp` after changing its code. Secrets are available without being committed.
- Do not disable CORS globally or expose the service-role key.

### The oracle choked

- Confirm `OPENAI_API_KEY` is set with `supabase secrets list`.
- Check **Supabase Dashboard → Edge Functions → judge-larp → Logs**.
- Verify the match status reached `judging`, the caller is `player_a`, and twenty JPEG frames were sent.
- Check OpenAI project access, quota, and `gpt-4o-mini` availability.
- Player A can retry from the themed error screen. The database caps a match at three attempts; Player B polls the saved result in case it missed the broadcast.

## Privacy and MVP limits

Live media remains peer-to-peer. Six compressed snapshots exist in Player A's browser memory only long enough to send one judging request; the app does not write images or video recordings to Supabase. The AI verdict remains briefly in the temporary match row, and old rows are opportunistically deleted. This friends-only MVP intentionally has no reporting/moderation system and should not be promoted as a public anonymous video platform without adding appropriate safety systems.
