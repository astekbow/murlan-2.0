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

A ready file is generated at **`packages/client/public/install/crypto-murlan.mobileconfig`** (app icon
already embedded; opens full-screen). Two edits before use:

1. Open it and replace `https://REPLACE_WITH_YOUR_DOMAIN/` with `https://YOUR_DOMAIN/`.
2. (Optional) regenerate the two `PayloadUUID` values (any unique UUIDs).

**Distribute it:** it ships in `public/`, so after deploy it's served at
`https://YOUR_DOMAIN/install/crypto-murlan.mobileconfig`. The user opens that link **in Safari** →
"This website is trying to download a configuration profile" → **Allow** → Settings shows
*Profile Downloaded* → **Install**. A home-screen "Crypto-Murlan" icon appears that launches the PWA
full-screen (landscape per the manifest + the in-app rotate lock).

- **Unsigned** profiles install fine but show an **"Unverified"** warning. To remove it, **sign** the
  `.mobileconfig` with an Apple-trusted cert:
  ```bash
  # with an Apple Developer cert in your Keychain:
  security cms -S -N "Your Cert Name" -i crypto-murlan.mobileconfig -o crypto-murlan-signed.mobileconfig
  ```
- This is **NOT** an App Store app and needs no Developer account to *work* — only to *sign* (remove the
  warning) or to ship a real native iOS app later (Capacitor/Swift wrapper).

### Serving note (nginx)
`.mobileconfig` is best served as `application/x-apple-aspen-config`. Safari downloads it by extension
regardless, but to be correct add to `deploy/nginx.conf` (inside the `server` block):
```nginx
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
