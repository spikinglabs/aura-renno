# Aura

A calm, phone-friendly baby and child log: feeds (with a breastfeeding timer), sleep (with a timer), diapers, solids, growth and notes. When your child is sick, turn on sick mode: temperature, medicine and symptoms move to the top, and you get a fever chart and a day-by-day summary to show the doctor. The screen dims to warm colors at night. No server of its own: data lives on the phone and, if you connect it, in one JSON file in your Google Drive.

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
3. Open your URL on the phone, then **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: menu → Install app).
4. In the app: **More → Google Drive** → paste the client ID → Connect. The log is saved as `Aura/aura-log.json` in your Drive.
5. Optional: **More → AI helper** → paste an Anthropic API key (from https://console.anthropic.com) to turn on "Say it in your own words" and the AI handover.

## How data is handled

- Saved on the phone first (works offline), then synced to Drive about two seconds after each change, while you're signed in. Tap the sync label at the top to sign in again after Google's one-hour sign-in expires.
- Merge is per entry (newest edit wins), so two phones on the **same Google account** can both log and sync.
- The `drive.file` scope means the app can only see files it created, not the rest of your Drive.
- The API key stays on the device and is never synced. When an AI button is used, the log text (never photos) goes to Anthropic.

## Upgrading from Sick Day Log

On first open, data saved on the phone by the earlier Sick Day Log is moved over automatically. Drive now uses a new file (`Aura/aura-log.json`); to bring an old Drive log across, use More → Your data → Restore with data copied from the old app.

## Known limits of this prototype

- Two parents with **different** Google accounts can't share one log yet. Next step is the Google Drive file picker so the second parent can open the shared file.
- Photos are stored small (720 px) inside the JSON file. Many photos will make the file large; a later version should store them as separate Drive files.
- Voice dictation uses the browser's speech recognition where available; otherwise use the keyboard's microphone key.
- The app shows reminders (fever beyond 3 days, very high temperature, babies under 3 months, no wet diaper for 8 h, repeated vomiting) and when a medicine's minimum gap has passed. It never suggests doses or diagnoses.
