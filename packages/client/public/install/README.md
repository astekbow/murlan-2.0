# Install assets

Drop the **signed Android app** here as **`crypto-murlan.apk`**:

```
packages/client/public/install/crypto-murlan.apk
```

It's then served at `https://YOUR_DOMAIN/install/crypto-murlan.apk` and the login page's **🤖 Android**
button downloads it. Build it with PWABuilder (https://www.pwabuilder.com → your URL → Android) or
Bubblewrap — see `MOBILE_PACKAGING.md`. Keep the signing key safe (you need it for updates).

> Don't commit the `.apk` if it's large / you prefer not to — just place it on the server's
> `public/install/` before/after deploy. The **iOS** profile needs no file here: the server builds it
> at `/api/install/ios.mobileconfig`.
