# Aura: from prototype to the official app

This plan answers the five points from L's request on 2026-10-07. "Built" means it is in the pull request that adds this file; "later" means it is planned but not built yet.

## 1. Data is local

**Built.**

How the data is stored: the whole log (children, entries, illnesses, growth, medicines) is one structured document (JSON). On the phone it sits in IndexedDB, the small database built into every browser, as a single record. In Google Drive and in backup files it is the same document saved as one `.json` file. There is no database server anywhere.

How it is protected against corruption:

- **No half-written saves.** Each save replaces the record in one IndexedDB transaction: it either completes or the previous version stays. A crash, a dead battery or closing the app mid-save cannot leave a half-written log. Drive works the same way: an upload becomes a new version of the file only when it finishes.
- **No saving a broken log.** Before every save the app checks that the log is well formed, and that it doesn't have fewer items than the last save. Deleting an entry only marks it deleted, so the count only goes down when the parent deletes everything. If a bug ever produced a broken or shrunken log, the save is refused and the stored log stays as it was.
- **No overwriting Drive with something worse.** The app reads the Drive file back after writing, and never writes over a Drive file it can't read.
- **Repairs on open.** A stored log missing a section (for example from an older version) is filled in on open instead of failing.
- **Copies to fall back on.** There are daily copies on the phone, the required off-phone backup, hourly and daily versions in Drive, and Google's own version history. Restoring only adds entries back; it never deletes.

The remaining risk is a mistake the parent makes and keeps for months (for example deleting entries by hand). Older Drive versions cover the last 60 days.

- IndexedDB replaces localStorage, which stops at about 5 MB; a few months of photos and sound clips would fill that. IndexedDB can hold hundreds of MB. Existing data moves over automatically the first time the new version opens.
- The app asks the browser to keep its storage permanently (`navigator.storage.persist()`), so the phone does not clear it to free space. More → Your data shows how much space is used and whether the browser agreed.
- Nothing leaves the phone except a backup the parent set up, or text sent when they tap an AI button.

## 2. Backups (required)

**Built.** A log that only lives on one phone is one lost phone away from gone, so backups are not optional.

- **Asked for at the start:** after adding the first child, Aura asks how to keep the log safe: Google Drive (automatic, recommended) or a backup file.
- **Reminded until done:** while there is no copy off the phone, or the last one is more than 2 days old and newer entries exist, Today shows a "Back up your log" banner with a "Back up now" button. It can be put off until tomorrow, not turned off.
- **Backup file without Google:** "Save a backup file" opens the phone's share sheet, so the file can go to iCloud Files, Dropbox, email or anywhere else; where sharing isn't available it downloads. "Restore from a backup file" merges one back in.
- **Google Drive, automatic:** one file `Aura/aura-log.json` in the parent's own Drive, updated a few seconds after each change and merged item by item (newest edit wins, deletions kept as markers). The `drive.file` permission means the app can only see files it created or that the parent picked, never the rest of their Drive.
- **Versions in Drive:** before the app overwrites the Drive file, it saves the file as it was to `Aura/backups/` (at most once an hour). It keeps every copy from the last 48 and then one per day for 60 days. Google Drive also keeps its own version history.
- **Daily copies on the phone:** each day the app is opened it keeps a full copy on the phone too (newest 14). These help after a bad edit but not after losing the phone, which is why the off-phone backup above is required.
- **Never overwrite with something worse:** if the Drive file can't be read as an Aura log, the app stops and says so instead of writing over it.

Why whole-log copies and not one file per entry: the whole log is small (text is a few hundred KB even after years; photos and clips add about 100 KB each), so a full copy is cheap, and restoring one file is simple and reliable. Many small files would make backups slower and restores fragile, and with the safe `drive.file` permission a partner's phone couldn't read files the other phone created (see point 3).

## 3. Two parents, one child

**Verdict: worth doing, and built, because Google Drive's own sharing makes it both safe and fairly easy.** There is still no Aura server; Google decides who can open the file.

How it works:

1. Parent A (whose Drive holds the log) goes to More → Google Drive → **Share with a partner**, types the partner's Google email, and taps Share. The app gives that one file "can edit" access through Google Drive. Google emails the partner.
2. Parent B opens Aura on their own phone, adds the same OAuth client ID, and taps **Join a shared log**. Google's file picker shows files shared with them; they pick `aura-log.json`. From then on both phones sync the same file.
3. Parent A sees who has access and can remove someone with one tap. Removing access in Google Drive works too.

Why this is safe:

- Access is per person, by Google account, and revocable. Nobody else can open the file, and Aura's developer has no copy.
- With `drive.file`, each phone's Aura can only open that one file, not anything else in either parent's Drive.
- Each entry remembers who logged it ("by Anna"), so it is clear who gave the last dose.

What it costs (one-time):

- Both parents must be added as test users on the Google OAuth consent screen (or the app gets verified by Google).
- The file picker needs an API key from the same Google Cloud project (README step 2). Only the parent joining needs it on their phone.

Known limits and what comes later:

- Two phones saving at the same moment: after writing, the app reads the Drive file back and checks that every entry it has is there. If the other phone's write replaced it in between, it merges again and rewrites (up to three times, then retries 20 seconds later). Entries are only ever added or updated by a merge, never dropped, and each phone keeps its own full copy, so a clash delays sync but cannot lose an entry. Deleting is a "deleted" marker that syncs like an edit, so a deletion can be undone from a backup.
- One file per entry was considered and rejected. With the safe `drive.file` permission, a phone can only open files it created or that were picked by hand, so a partner's phone could not see entries the other parent created. It would also mean thousands of files and hundreds of requests per sync on a phone. One shared file plus check-after-write plus frequent backups is safer.
- Later, optional: encrypt the Drive file with a family passphrase, so even Google only stores scrambled data. It is not built yet because a forgotten passphrase would mean losing the Drive copy, and the passphrase has to be typed on each phone.

## 4. Voice and sounds

**Voice entry, built:**

- Every free-text box (notes, symptoms, doctor's notes, "Say it") has a microphone button. Tap to dictate, tap again to stop. It uses the phone's speech recognition; where the browser lacks it, the button is hidden and the keyboard's own microphone key still works.
- "Say it" no longer needs AI: without an API key, the dictated text can be saved as a note. With AI it is turned into entries, which you check before adding (as before).

**Sound recordings, built, because it makes sense:** doctors often ask what a cough or breathing sounds like (barking, whistling, rattling), and a sound is hard to describe at 3 am.

- In sick mode there is a **Sound** button. It records up to 30 seconds from the microphone, with a note ("whistling when breathing in"). The clip plays back in the timeline, in the sick overview and in "For the doctor".
- Clips are small (compressed speech-quality audio, about 100 KB for 30 seconds) and are stored and synced like photos, so a partner sees them too.
- Instead of recording, a parent can paste a link to a video kept elsewhere (Google Photos, iCloud), for example a video of breathing that shows the chest.
- Sounds and photos are never sent to AI, except pages of the vaccination book or U-Heft the parent chooses to scan (see the Vaccines and Checkups tabs).

Later: when there are many photos and clips, move them out of the log file into their own Drive files (the picker can then grant the partner access to them too), so each sync stays small.

## 5. AI helpers with privacy

Principles (built into every AI call):

1. **Off unless the parent turns it on, with the service they choose.** More → AI helper offers Anthropic (Claude) or any service that speaks the common OpenAI-style chat API: OpenAI, Google Gemini, Mistral, OpenRouter, a company's own endpoint, or a model running locally with Ollama or LM Studio. The parent picks the address and model and adds their own key. The key stays only on that phone and is never synced. Only `https://` addresses are accepted (or `http://localhost` for a local model), so the log never travels unencrypted.
2. **Send the least possible.** Before anything goes out, the app replaces each child's name with a placeholder ("[CHILD]"), sends the age instead of the birth date, drops the "by" names, photos, sound clips, links and Drive details, and puts the real name back into the answer on the phone.
3. **Show what was sent.** The first time, the app explains what will be sent and asks once. After each AI answer there is a "See what was sent" link with the exact text.
4. **Never medical advice.** Prompts forbid diagnoses, doses and treatment suggestions; the app shows its own reminders, which are fixed rules, not AI.

About the provider: requests go straight from the phone to the service the parent chose; Aura has no server in between. How long the service keeps the text and whether it trains on it depends on that service's terms, so the AI card says which service is in use. Anthropic, for example, does not train on API inputs by default. The most private choice is a local model (Ollama or LM Studio), where nothing leaves the computer.

AI helpers, now and later:

| Helper | Status |
| --- | --- |
| "Say it": turn a spoken or typed note into entries | Built (redacted) |
| Doctor handover written from the illness log | Built (redacted) |
| Ask: questions about the log ("when did she last have ibuprofen?", "how much did he drink yesterday?"), answered only from the log | Later |
| Weekly digest of sleep and feeding patterns, no advice | Later |
| Local model on a computer (Ollama, LM Studio) | Built (any OpenAI-style address) |
| On-device model on the phone (Chrome's built-in model or WebLLM), so nothing leaves the phone | Later, when phones support it widely |

## Order of work

1. This pull request: IndexedDB storage, file and Drive backups, partner sharing, dictation everywhere, sound recordings, AI redaction and "see what was sent".
2. Next: Ask chat; media in separate Drive files; optional passphrase encryption; translations from the old aura repo.
