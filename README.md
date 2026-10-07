# Aura

A calm, phone-friendly baby and child log: feeds (with a breastfeeding timer), sleep (with a timer), diapers, solids, growth and notes. When your child is sick, turn on sick mode: temperature, medicine and symptoms move to the top, and you get a fever chart and a day-by-day summary to show the doctor. The screen dims to warm colors at night. No server of its own: data lives on the phone and, if you connect it, in one JSON file in your Google Drive, which you can share with a partner. In sick mode you can also record a short sound (a cough, noisy breathing) for the doctor.

The plan behind this version is in [docs/official-app-plan.md](docs/official-app-plan.md).

**Live app:** https://emptymalei.github.io/aura2/

## Files

- `src/app.html` is the whole app (HTML, CSS and JavaScript in one file). `sh build.sh` wraps it into `app/index.html`, which is not committed.
- `app/` holds the rest of the installable app: `manifest.json`, `sw.js` for offline use, and `icon.svg`.
- `tests/smoke.mjs` opens the built app at phone width in day and night colors and checks the main screens, timers and data migration.
- `.github/workflows/pages.yml` runs the test on every push and pull request, and publishes `app/` to GitHub Pages on each push to `main`.

## Development

```sh
npm install
npx playwright install chromium   # once
npm test                          # builds, then runs the smoke test
```

Open `app/index.html` in a browser to try it locally. Google Drive sync only works from the hosted https address.

## Put it on your phone (one-time, about 15 minutes)

1. **Hosting** is already done: every push to `main` publishes the app to https://emptymalei.github.io/aura2/.
2. **Create a Google OAuth client ID** (needed only for Drive sync):
   - Go to https://console.cloud.google.com, create a project, and enable the **Google Drive API**.
   - OAuth consent screen: External, add yourself (and your partner) as test users. Scope: `.../auth/drive.file`.
   - Credentials → Create credentials → OAuth client ID → Web application. Add `https://emptymalei.github.io` under **Authorized JavaScript origins**.
   - Copy the client ID.
   - Only for sharing with a partner: enable the **Google Picker API**, then Credentials → Create credentials → API key. Restrict it to the Google Picker API and to the website `https://emptymalei.github.io/*`. The partner pastes this key when they tap **Join a shared log**.
3. Open your URL on the phone, then **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: menu → Install app).
4. In the app: **More → Google Drive** → paste the client ID → Connect. The log is saved as `Aura/aura-log.json` in your Drive.
5. Optional, to share with a partner: add them as a test user on the OAuth consent screen. Then **More → Share with a partner** → their Google email → Share. On their phone: **More → Google Drive → Join a shared log**, paste the client ID and API key, and pick `aura-log.json`.
6. Optional: **More → AI helper** → pick a service and paste its key to turn on "Say it" sorting and the AI handover. Choices: Anthropic (key from https://console.anthropic.com), or any OpenAI-style chat service (OpenAI, Gemini, Mistral, OpenRouter, your own endpoint) with its address and model name. For a local model in Ollama, open Aura on that same computer and start Ollama with `OLLAMA_ORIGINS=https://emptymalei.github.io` so the browser may call it.

## How data is handled

- The whole log is one JSON document: on the phone it's a single record in the browser's IndexedDB (works offline), in Drive and backups it's one `.json` file. The app asks the browser to keep it permanently; installing the app to the home screen helps.
- **Backups are required.** After the first child is added, Aura asks for Google Drive or a backup file, and Today shows a reminder while there's no copy off the phone or the last one is over 2 days old with newer entries. **More → Your data → Save a backup file** opens the share sheet (iCloud Files, Dropbox, email…).
- Synced to Drive about two seconds after each change, while you're signed in. Tap the sync label at the top to sign in again after Google's one-hour sign-in expires.
- Before the Drive file is changed, the old version is saved in `Aura/backups` (at most hourly; the last 48 kept, then one a day for 60 days), and the phone keeps a daily copy of its own (14 days). After each write the app reads the file back to check nothing was lost to another phone saving at the same time, and it never writes over a Drive file it can't read. **More → Google Drive → Restore from a Drive backup** and **More → Your data → Restore a daily copy** add back anything missing.
- Merge is per entry (newest edit wins), so several phones can log at once: the same Google account, or a partner you shared the file with. Each entry shows who logged it if you set your name under **Share with a partner**.
- The `drive.file` scope means the app can only see files it created, not the rest of your Drive.
- The API key stays on the device and is never synced. When an AI button is used, the text needed goes to the AI service you chose with names replaced by placeholders and age instead of birth date. Photos, sounds and links are never sent. Each AI answer has a "See exactly what was sent" link.

## Upgrading from Sick Day Log

On first open, data saved on the phone by the earlier Sick Day Log is moved over automatically. Drive now uses a new file (`Aura/aura-log.json`); to bring an old Drive log across, use More → Your data → Restore with data copied from the old app.

## Known limits of this prototype

- Photos (720 px) and sound clips (up to 30 s) are stored inside the JSON file. Many of them will make each sync slower; a later version should store them as separate Drive files.
- Dictation (the microphone button on text boxes) uses the browser's speech recognition where available; otherwise use the keyboard's microphone key.
- Partner sharing and Drive backups use Google's APIs, which the automated test cannot reach; try them on the live app.
- The app shows reminders (fever beyond 3 days, very high temperature, babies under 3 months, no wet diaper for 8 h, repeated vomiting) and when a medicine's minimum gap has passed. It never suggests doses or diagnoses.
