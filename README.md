# Booper

A privacy-focused disappearing messaging app. Send photo and video messages (called "boops") that can only be viewed once.

- **End-to-end encryption**: server stores only opaque encrypted blobs, only you and the recipient can decrypt the content
- **No app to install**: runs in your browser, works on desktop and mobile
- **No accounts**: neither sender nor recipient needs to sign up

Take a photo or video, get a link, share it however you like. View once, then it's gone. Use [booper.xyz](https://booper.xyz) or [host your own](#deploy-your-own-cloudflare-pages) for free on Cloudflare.

Inspired by [Explode app](https://x.com/nikitabier/status/1879206793118658974) by Nikita Bier, which is no longer available. This is an open-source, web-based alternative.

*Note: Booper does not detect or block screenshots. And even if we did, the recipient could just take a photo of the screen! Boop accordingly.*

<p align="center">
   <img src="https://github.com/user-attachments/assets/76cb4a62-da6e-4883-9ff3-f6aa7fdb6226" width="200">
</p>


## Features

- **Photos**: optional text overlay, adjustable view duration (1–10s)
- **Videos**: record up to 15s, expires when playback ends
- **Auto-expiration**: unopened boops expire after 7 days
- **Push notifications**: optional, get notified when your boop is opened (includes approximate location)
- **PWA**: installable on mobile home screen to receive notifications

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/RogerPodacter/booper.git
cd booper
npm install

# 2. Create KV namespace
npx wrangler kv namespace create BOOP_KV
# Copy the namespace ID from output

# 3. Configure
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml with your namespace ID

# 4. Deploy
npm run deploy
```

For push notifications, see [full setup](#deploy-your-own-cloudflare-pages) below.

## Limits

| Resource | Limit |
|----------|-------|
| Content size | 3 MB max (after compression) |
| Video recording | 15 seconds |
| Text overlay | 200 characters |
| View duration (photos) | 1–10 seconds |
| Rate limit | 50 boops/IP/hour |
| Unopened expiration | 7 days |

Photos are compressed client-side (max 1200×1200, JPEG 80%) before encryption.

## Browser Support

Booper requires modern browser APIs:

| Feature | Required For |
|---------|--------------|
| Web Crypto API | Encryption (AES-GCM) |
| MediaDevices API | Camera/video capture |
| Service Workers | PWA, push notifications |
| MediaRecorder API | Video recording |

**Supported browsers**: Chrome 60+, Safari 14+, Firefox 60+, Edge 79+

## How It Works

### Sending

1. Capture a photo or record a video.
2. The client generates a random `id` and an AES‑GCM 256-bit key.
3. The client encrypts two payloads with that key:
   - `encryptedMeta`: `{ contentType, viewDuration }`
   - `encryptedContent`: the actual photo/video + overlay text
4. The client uploads to `POST /api/secrets` and shares a link like:

   `https://<your-domain>/s/<id>#<key>`

   The `#<key>` fragment is required to decrypt and is never sent to servers by browsers.

### Viewing

1. Recipient opens the link.
2. Client calls `GET /api/secrets/:id/status` to fetch `encryptedMeta`, decrypts locally to learn type/duration.
3. On "Reveal", client calls `POST /api/secrets/:id/reveal` to fetch `encryptedContent` (one-time), server marks as opened.
4. Content displays briefly, then expires (with visual effects).

### Link Previews (OG/Twitter)

Link previews can't access the `#<key>` fragment. Booper uses Cloudflare HTMLRewriter to serve generic preview metadata for `/` and `/s/...` (see `functions/index.ts` and `functions/s/[[path]].ts`). No content information is leaked in previews.

## Threat Model

Booper protects against **server-side disclosure** of stored content. It does **not** prevent:

- screenshots / screen recording
- malicious browser extensions
- compromised devices
- someone obtaining the full link (including `#<key>`)

## Tech Stack

- **Frontend**: React 19 + Vite + Tailwind CSS v4
- **Backend**: Cloudflare Pages Functions
- **Storage**: Cloudflare KV
- **Encryption**: AES‑GCM 256-bit via Web Crypto API
- **Push**: Web Push (VAPID)

## Deploy Your Own (Cloudflare Pages)

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)

### Cloudflare Free Tier Limits

Booper runs on Cloudflare's free tier. The practical limit is **~300-500 boops/day**, constrained by KV writes:

| Resource | Free Tier | Booper Usage |
|----------|-----------|--------------|
| KV writes | 1,000/day | 2 per send, 1 per reveal |
| KV reads | 100,000/day | 2 per send, 2 per reveal, 1 per status |
| KV storage | 1 GB | ~3 MB max per boop |
| Functions | 100,000/day | 1 per API call |

**In practice**: ~500 sends/day if nobody opens them same-day, or ~333 full send+open cycles if they do. Great for personal use or small groups. If you expect public traffic, consider a paid tier.

Quotas change—check [Cloudflare's current limits](https://developers.cloudflare.com/workers/platform/limits/).

### 1) Create KV namespace

```bash
npx wrangler kv namespace create BOOP_KV
```

Copy the namespace ID from the output.

### 2) Generate VAPID keys (optional, for push notifications)

```bash
npx web-push generate-vapid-keys
```

You'll get:

- `VAPID_PUBLIC_KEY` (safe to expose)
- `VAPID_PRIVATE_KEY` (keep secret)

You'll also need a `VAPID_SUBJECT` (contact email like `mailto:you@example.com`).

Push notifications are disabled by default. Set `NOTIFICATIONS_ENABLED = "true"` in step 3 to enable them.

### 3) Configure `wrangler.toml`

```bash
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml`:

- `id` under `[[kv_namespaces]]` — namespace ID from step 1
- `VAPID_PUBLIC_KEY` — public key from step 2 (or leave placeholder if disabled)
- `VAPID_SUBJECT` — your email with `mailto:` prefix
- `NOTIFICATIONS_ENABLED` — set to `"true"` to enable push notifications

### 4) Set the VAPID private key secret (push only)

Via CLI:

```bash
npx wrangler pages secret put VAPID_PRIVATE_KEY --project-name <your-pages-project-name>
```

Replace `<your-pages-project-name>` with the name of your Cloudflare Pages project.

Or via Cloudflare Dashboard:

1. Pages → your project → Settings → Environment variables
2. Add `VAPID_PRIVATE_KEY` as an encrypted variable (Production)

### 5) Deploy

```bash
npm run deploy
```

After deployment, Cloudflare will provide your URL (e.g., `your-project.pages.dev`). You can add a custom domain in the Cloudflare dashboard.

## Local Development

```bash
npm install
npm run dev
```

Runs:

- Vite dev server (default `http://localhost:5173`)
- Wrangler Pages dev server for Functions (on `http://localhost:3001`)

Vite proxies `/api/*` → `http://localhost:3001` (see `vite.config.ts`).

### Local dev secrets

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your VAPID_PRIVATE_KEY
```

### Build/preview

```bash
npm run build
npm run preview
```

## Troubleshooting

### Camera not working

- **Check permissions**: Browser must have camera access granted
- **Secure context**: Camera API requires HTTPS (localhost works for dev)

### Push notifications not working

- **VAPID keys**: Ensure all three values are set (public key, private key, subject)
- **User permission**: User must enable notifications in the app

### Deployment fails

- **Wrangler login**: Run `npx wrangler login` if not authenticated
- **KV namespace**: Ensure ID in `wrangler.toml` matches your created namespace
- **Node version**: Requires Node.js 18+

### "Rate limited" error

The default limit is 50 boops per IP per hour. Wait or deploy your own instance with modified limits in `functions/_shared/kv.ts`.

## API

### `POST /api/secrets`

Create an encrypted secret.

```json
{
  "id": "AbC123xY",
  "encryptedMeta": "<base64>",
  "encryptedContent": "<base64>",
  "pushSubscription": { "...": "optional" }
}
```

Limits: `id` 6–12 alphanumeric, meta ≤10KB, content ≤3MB, 50 creates/IP/hour.

### `GET /api/secrets/:id/status`

- `200 { "status": "pending", "encryptedMeta": "..." }`
- `200 { "status": "revealed" }`
- `404 { "status": "not_found" }`

KV TTL handles expiry; expired boops return `not_found`.

### `POST /api/secrets/:id/reveal`

One-time reveal. Returns `{ "encryptedContent": "..." }` or `410` if already opened.

### `GET /api/vapid-public-key`

Returns `{ "enabled": true, "publicKey": "..." }` or `{ "enabled": false }`.

## Storage Model

Stored in Cloudflare KV under `secret:<id>`:

- `encrypted_meta` — encrypted `{ contentType, viewDuration }`
- `encrypted_content` — encrypted media payload
- `push_subscription` — optional

**Retention:**

- Unopened secrets: 7 day TTL
- After reveal: replaced with minimal tombstone (`{ revealed: true }`) with 48h TTL

**Note:** Cloudflare KV is eventually consistent. In rare cases, if two reveals happen simultaneously from different regions before the tombstone propagates, both may succeed. For this use case, the risk is acceptable—worst case, two people see the same photo.

## Project Structure

```
src/
  pages/
    Home.tsx          # Capture, encrypt, share, history, push subscribe
    Reveal.tsx        # Status, reveal, decrypt, view-once UX
  components/         # PixelExplosion, PixelatedImage
  crypto.ts           # AES-GCM + image compression
functions/
  api/                # API routes
  _shared/            # KV + Web Push helpers
  s/[[path]].ts       # OG/Twitter meta rewrite for shared links
public/
  sw.js               # Service worker (PWA + Push)
  _redirects          # SPA routing on Pages
```

## Alternative Deployments

Booper's architecture is portable. You'll need:

- Static hosting for the frontend
- Serverless/edge functions for API routes
- KV store with TTL support
- HTTPS

## License

MIT — see [LICENSE](LICENSE)
