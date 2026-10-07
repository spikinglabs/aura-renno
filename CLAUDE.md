# Aura

Serverless baby and child log (PWA). Everything is in `src/app.html`; `sh build.sh` wraps it into `app/index.html` (not committed).

- No own server. Data is in localStorage (`aura.v2`) and optionally one JSON file in the user's Google Drive (`drive.file` scope), merged per item by `updatedAt` with `deleted: true` tombstones. Add any new synced collection to `SYNCED`.
- The app never gives medical, dose or diagnosis advice; it only shows reminders and when a medicine's minimum gap has passed. AI prompts must keep that rule.
- Notes (including doctor's notes) are free text, not forms.
- Daily tracking is customizable per child (`TRACKERS`, `child.track`, defaults from `suggestedTrack` by age). Anything tied to a tracker (quick button, summary card, timeline rows, doctor table column) must hide when it is off.
- Design is "Night light": warm dark palette at night, warm cream by day, tokens on `:root` and `:root[data-mode="day"]`. Must work at 375 px width without sideways scrolling.
- Run `npm test` before pushing (set `CHROMIUM_PATH` if Playwright's own browser is not installed). Pushes to `main` deploy to GitHub Pages.
