# Allo Auri

Auri (formerly Aura) is part of the Allo family of tools for family life in Germany, next to [Allo Outings](https://outings.allo.land).


A calm, phone-friendly baby and child log: feeds (with a breastfeeding timer), sleep (with a timer), diapers, solids, growth and notes. When your child is sick, turn on sick mode: temperature, medicine and symptoms move to the top, and you get a fever chart and a day-by-day summary to show the doctor. The screen dims to warm colors at night. No server of its own: data lives on the phone and, if you connect it, in one JSON file in your Google Drive, which you can share with a partner. In sick mode you can also record a short sound (a cough, noisy breathing) for the doctor.

The plan behind this version is in [docs/official-app-plan.md](docs/official-app-plan.md).

**Live app:** https://auri.allo.land/ (the old addresses aura.allo.land and leima.is/aura2 forward here)

## Files

- `src/app.html` is the whole app (HTML, CSS and JavaScript in one file). `sh build.sh` wraps it into `app/index.html`, which is not committed.
- `app/` holds the rest of the installable app: `manifest.json`, `sw.js` for offline use, `icon.svg`, and `_headers` (response headers Cloudflare sends with every file).
- `tests/smoke.mjs` opens the built app at phone width in day and night colors and checks the main screens, timers and data migration.
- `.github/workflows/test.yml` runs the test on every push and pull request. Cloudflare Pages publishes `app/` on each push to `main` (see Hosting below).

## Development

```sh
npm install
npx playwright install chromium   # once
npm test                          # builds, then runs the smoke test
```

Open `app/index.html` in a browser to try it locally. Google Drive sync only works from the hosted https address.

## Put it on your phone

1. Open https://auri.allo.land/ on the phone, then **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: menu → Install app).
2. **More → Google Drive → Connect Google Drive**, and sign in with Google. The log is saved as `Aura/aura-log.json` in your Drive.
3. Optional, to share with a partner: **More → Share with a partner** → their Google email → Share. On their phone: **More → Google Drive → Join a shared log**, and pick `aura-log.json`.
4. Optional: **More → AI helper** → pick a service and paste its key to turn on "Say it" sorting and the AI handover. Choices: Anthropic (key from https://console.anthropic.com), or any OpenAI-style chat service (OpenAI, Gemini, Mistral, OpenRouter, your own endpoint) with its address and model name. For a local model in Ollama, open Aura on that same computer and start Ollama with `OLLAMA_ORIGINS=https://auri.allo.land` so the browser may call it.

## Hosting (one-time, for the maintainer)

Auri is a Cloudflare Pages project (static files only, no server code) at `https://auri.allo.land`.

1. Cloudflare dashboard, in the account that holds the `allo.land` zone → **Workers & Pages → Create → Pages → Connect to Git** → `spikinglabs/aura-renno`.
2. Production branch `main`, framework preset None, build command `sh build.sh`, build output directory `app`. Under **Environment variables**, add `GOOGLE_CLIENT_ID` and `GOOGLE_PICKER_KEY`.
3. After the first deploy: the project's **Custom domains** tab → add `auri.allo.land`. Cloudflare creates the DNS record and certificate. Every push to `main` deploys again, and other branches get a preview address on `pages.dev` (Google sign-in only works on `auri.allo.land`).

`app/_headers` sets the response headers. The content security policy is report-only for now: open the browser console on the live app, use Drive sync, the picker and an AI call, and once nothing is reported, rename the header to `Content-Security-Policy`.

## Auri's Google project (one-time, for the maintainer)

Users only tap "Connect Google Drive" because the app ships with Auri's own Google client ID and picker key. Both are public by design: Google only accepts them from this site's address. To set them up once:

1. https://console.cloud.google.com → create a project named **Auri** (the existing one is still called Aura, which is fine). Enable the **Google Drive API** and the **Google Picker API**.
2. **Google Auth Platform → Branding** (OAuth consent screen): app name Allo Auri, a support email, home page `https://auri.allo.land/`, privacy policy `https://auri.allo.land/privacy.html`, authorized domain `allo.land`. Audience: **External**.
3. **Data access**: add only the scope `.../auth/drive.file`. This is a non-sensitive scope, so no security assessment is needed.
4. **Clients → Create client → Web application**. Under **Authorized JavaScript origins** add `https://auri.allo.land`. Copy the client ID.
5. **APIs & Services → Credentials → Create credentials → API key**. Restrict it to the **Google Picker API** and to websites `https://auri.allo.land/*`. Copy the key.
6. Add `GOOGLE_CLIENT_ID` and `GOOGLE_PICKER_KEY` with those values in two places: as **environment variables** of the Cloudflare Pages project (so the live app gets them), and on GitHub under **repo Settings → Secrets and variables → Actions → Variables** (so the test builds with them). The next deploy builds them into the app (retry the latest deployment in Cloudflare, or push any change).
7. While the app is in **Testing**, only test users you add under **Audience** (up to 100) can sign in. To open it to everyone, click **Publish app**. With only `drive.file`, Google asks for brand verification (it checks the name, logo, home page and privacy policy, and that you own the domain via Google Search Console), which usually takes a few days.

People who prefer their own Google project can still enter their own client ID and key under **More → Google Drive → Advanced**.

## How data is handled

- The whole log is one JSON document: on the phone it's a single record in the browser's IndexedDB (works offline), in Drive and backups it's one `.json` file. The app asks the browser to keep it permanently; installing the app to the home screen helps.
- **Backups are required.** After the first child is added, Auri asks for Google Drive or a backup file, and Today shows a reminder while there's no copy off the phone or the last one is over 2 days old with newer entries. **More → Your data → Save a backup file** opens the share sheet (iCloud Files, Dropbox, email…).
- Synced to Drive about two seconds after each change, while you're signed in. Tap the sync label at the top to sign in again after Google's one-hour sign-in expires.
- Before the Drive file is changed, the old version is saved in `Aura/backups` (at most hourly; the last 48 kept, then one a day for 60 days), and the phone keeps a daily copy of its own (14 days). Photos, document pages and sound recordings are inside the log, so they sync to a partner and go into every backup; Drive backups keep each one only once, as its own file in `backups/media`, so hourly copies don't fill up Drive. After each write the app reads the file back to check nothing was lost to another phone saving at the same time, and it never writes over a Drive file it can't read. **More → Google Drive → Restore from a Drive backup** and **More → Your data → Restore a daily copy** add back anything missing.
- Merge is per entry (newest edit wins), so several phones can log at once: the same Google account, or a partner you shared the file with. Each entry shows who logged it if you set your name under **Share with a partner**.
- The `drive.file` scope means the app can only see files it created or that you picked, not the rest of your Drive. See the [privacy policy](https://auri.allo.land/privacy.html).
- The API key stays on the device and is never synced. When an AI button is used, the text needed goes to the AI service you chose with names replaced by placeholders and age instead of birth date. Photos, sounds and links are never sent. Each AI answer has a "See exactly what was sent" link.

## Moving from the old address

Auri used to be called Aura and lived at `aura.allo.land`, before that at `leima.is/aura2` (and `emptymalei.github.io/aura2`). A phone keeps the log per address, so it doesn't follow to `auri.allo.land` by itself. Before the old address was switched off, the log had to be in Google Drive or saved as a backup file; on `auri.allo.land`, **More → Google Drive → Connect Google Drive** (same Google project, so the same `Aura/aura-log.json`) or **More → Your data → Restore from a backup file** brings it back. The old addresses now only forward here. Drive keeps the folder name `Aura` and the file `aura-log.json`, so an existing log is found as it is.

## Upgrading from Sick Day Log

On first open, data saved on the phone by the earlier Sick Day Log is moved over automatically. Drive now uses a new file (`Aura/aura-log.json`); to bring an old Drive log across, use More → Your data → Restore with data copied from the old app.

## Known limits of this prototype

- Photos (720 px) and sound clips (up to 30 s) are stored inside the JSON file. Many of them will make each sync slower; a later version should store them as separate Drive files.
- Dictation (the microphone button on text boxes) uses the browser's speech recognition where available; otherwise use the keyboard's microphone key.
- Partner sharing and Drive backups use Google's APIs, which the automated test cannot reach; try them on the live app.
- The app shows reminders (fever beyond 3 days, very high temperature, babies under 3 months, no wet diaper for 8 h, repeated vomiting) and when a medicine's minimum gap has passed. It never suggests doses or diagnoses.
