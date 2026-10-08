# Aura

Serverless baby and child log (PWA). Everything is in `src/app.html`; `sh build.sh` wraps it into `app/index.html` (not committed).

- No own server. Data is in IndexedDB (`aura` database, store `kv`, key `state`; older localStorage `aura.v2` is moved over on load) and optionally one JSON file in the user's Google Drive (`drive.file` scope), merged per item by `updatedAt` with `deleted: true` tombstones. Add any new synced collection to `SYNCED` (now: children, episodes, entries, meds, measurements, growth, products).
- Log format version is `SCHEMA` in `src/app.html`. A new collection or new fields need no version change: older apps keep parts they don't know. Changing what existing data means needs `SCHEMA + 1`, a `MIGRATIONS` step and a test that upgrades a saved old log. The log as it was is kept as `before-vN` (phone) and `backups/aura-log-before-vN.json` (Drive), and an older app never writes a newer log.
- The app never gives medical, dose or diagnosis advice; it only shows reminders and when a medicine's minimum gap has passed. AI prompts must keep that rule, and every AI call goes through `ai()`, which swaps names for placeholders and talks to Anthropic or any OpenAI-style chat API the user configures; photos, sounds, links and birth dates never go into a prompt.
- Partners share by Google Drive permissions on the one log file (joiner picks it with the Google Picker). Sound clips (max 30 s) are stored inline in entries like photos, so they sync to partners.
- Product recalls come from L's Recall Tracker (spikinglabs/recall-tracker): one public JSON file on R2 (`RECALL_URL`), fetched by the phone at most every 12 h and cached locally in `S.recalls` (not synced). The family's product list (`products`) is matched on the phone and never sent anywhere.
- Notes (including doctor's notes) are free text, not forms.
- Daily tracking is customizable per child (`TRACKERS`, `child.track`, defaults from `suggestedTrack` by age). Anything tied to a tracker (quick button, summary card, timeline rows, doctor table column) must hide when it is off.
- Design is "Night light": warm dark palette at night, warm cream by day, tokens on `:root` and `:root[data-mode="day"]`. Must work at 375 px width without sideways scrolling.
- Run `npm test` before pushing (set `CHROMIUM_PATH` if Playwright's own browser is not installed). Pushes to `main` deploy to GitHub Pages.
