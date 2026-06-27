# Installing Crypto-Murlan as a native-feeling app

The app is a **PWA** (web app served over HTTPS). You don't rewrite anything — you *wrap* the deployed
site. Two distribution channels:

- **Android → an `.apk`** via a **TWA** (Trusted Web Activity): a thin native shell that opens your PWA
  full-screen, no browser bars. Installable/side-loadable or publishable to Google Play.
- **iOS → a `.mobileconfig`** (a configuration profile with a **Web Clip**): a downloadable file that
  installs a home-screen icon opening the PWA full-screen. No App Store needed.

> **Prerequisite:** the app must be live on a real HTTPS domain (the `CADDY_DOMAIN` you deploy with).
> Replace `REPLACE_WITH_YOUR_DOMAIN` everywhere below with that domain (e.g. `murlan.app`).

---

## 1. Android `.apk` (TWA)

### Easiest — PWABuilder (cloud, signs for you)
1. Deploy the site (so `https://YOUR_DOMAIN/manifest.webmanifest` is reachable — it already declares
   `"display":"standalone"` + `"orientation":"landscape"`).
2. Go to **https://www.pwabuilder.com**, enter `https://YOUR_DOMAIN`, **Package For Stores → Android**.
3. Package id: use **`com.cryptomurlan.twa`** (must match `public/.well-known/assetlinks.json`).
4. Download the zip. It contains:
   - `app-release-signed.apk` (sideload / share directly) **and** `.aab` (for Google Play).
   - a **`signing-key-info`** (KEEP IT SAFE — you need the same key to ship updates).
   - the **SHA-256 fingerprint** of the signing key + an `assetlinks.json`.
5. Put that fingerprint into `public/.well-known/assetlinks.json` (replace
   `REPLACE_WITH_YOUR_APK_SIGNING_SHA256_FINGERPRINT`), redeploy, and confirm
   `https://YOUR_DOMAIN/.well-known/assetlinks.json` returns **200 + `Content-Type: application/json`**,
   no redirect. (Without this the APK shows the URL bar instead of full-screen.)
6. Install the `.apk` (enable "install unknown apps") or upload the `.aab` to Google Play.

### Alternative — Bubblewrap (local CLI, full control)
```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://YOUR_DOMAIN/manifest.webmanifest
#   → applicationId: com.cryptomurlan.twa  · orientation: landscape
bubblewrap build           # prompts to create/sign a keystore → app-release-signed.apk
bubblewrap fingerprint     # prints the SHA-256 → paste into assetlinks.json (step 5 above)
```
Needs JDK 17 + Android SDK (Bubblewrap can install them). The keystore it creates is your signing
identity — back it up.

---

## 2. iOS `.mobileconfig` (Web Clip)

**Nothing to edit — the server generates it.** The route `GET /api/install/ios.mobileconfig`
(`packages/server/src/http/installRoutes.ts`) builds the profile on the fly from the request origin
(the app icon is embedded), so it always points at whatever domain it's served from. The in-app
**Install** prompt shows a one-tap **"Install profile"** button on iOS that links to it.

**The user flow (iPhone/iPad, in Safari):**
1. Tap **Install profile** in the app (or open `https://YOUR_DOMAIN/api/install/ios.mobileconfig`).
2. "This website is trying to download a configuration profile" → **Allow**.
3. **Settings** → *Profile Downloaded* (top, or *General → VPN & Device Management*) → **Install**.
4. A home-screen **Crypto-Murlan** icon appears → launches full-screen, landscape.

- **Signed = no warning (recommended).** The server **auto-signs** the profile (CMS/DER) when you point
  two env vars at the domain's TLS cert — iOS then shows **"Verified"** (green, with your domain) and
  **no "Unsigned"/"Not Verified" warning**:
  ```
  IOS_PROFILE_SIGN_CERT=/certs/fullchain.pem   # leaf + intermediate (the Let's Encrypt / Caddy cert)
  IOS_PROFILE_SIGN_KEY=/certs/privkey.pem      # its private key
  ```
  iOS only trusts a signature that chains to a **public** root, so this MUST be the domain's real
  (Let's Encrypt) cert — a self-signed cert would still read "Not Verified". If the vars are unset (or
  the cert is unreadable) the route falls back to the **unsigned** profile — it still installs, just with
  the "Unverified" label; a misconfigured cert now logs `[install] iOS .mobileconfig signing FAILED …`.

  **Turnkey on the single-host deploy** (`docker-compose.deploy.yml`): Caddy stores its Let's Encrypt
  cert `0600`/root in `caddy_data`, which the unprivileged `node` server can't read — so an opt-in
  **`ios-cert-sync`** sidecar copies it into the `ios_certs` volume, `chown`ed to the server's uid. The
  cert hostname is taken from `CADDY_DOMAIN` automatically. To enable, in `.env`:
  ```
  IOS_PROFILE_SIGN_CERT=/ios-certs/fullchain.pem
  IOS_PROFILE_SIGN_KEY=/ios-certs/privkey.pem
  ```
  then bring it up with the profile:
  ```
  docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile ios-signing up -d
  ```
  The sidecar refreshes every 12h (follows cert renewals); the runtime image already has `openssl`.
- This is **NOT** an App Store app and needs no Developer account to *work*.

### Serving note (nginx)
The route is under `/api/`, already proxied to the server, which sets `Content-Type:
application/x-apple-aspen-config` itself (that MIME is what makes Safari offer to install it). No nginx
change needed for iOS.
```nginx
# (legacy — only if you also host a STATIC .mobileconfig somewhere)
location ~ \.mobileconfig$ { default_type application/x-apple-aspen-config; }
```
Also confirm dot-dirs ship: after `vite build`, `dist/.well-known/assetlinks.json` and
`dist/install/crypto-murlan.mobileconfig` must exist (Vite copies `public/` verbatim).

---

## Cheat-sheet
| | Android | iOS |
|---|---|---|
| Artifact | `.apk` / `.aab` | `.mobileconfig` |
| Tool | PWABuilder or Bubblewrap | the generated file (sign optional) |
| Needs signing key | **yes** (keep it!) | only to drop the "Unverified" warning |
| Domain file to host | `/.well-known/assetlinks.json` | `/install/crypto-murlan.mobileconfig` |
| Full-screen + landscape | from the manifest | from the manifest + the Web Clip |

Both rely on the manifest (`orientation: landscape`) + the in-app rotate lock already shipped, so the
installed app is landscape-only on phones/tablets.
