// Opens the built app at phone width and checks the main screens render without errors or sideways scrolling.
import { chromium } from 'playwright';

const url = new URL('../app/index.html', import.meta.url).href;
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
const fail = m => { errors.push(m); };
// The app keeps its log in IndexedDB ('aura' database, 'kv' store, key 'state').
const IDB = `const idb = mode => new Promise((res, rej) => { const r = indexedDB.open('aura', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });`;
const getState = (page, key = 'state') => page.evaluate(`(async () => { ${IDB} const d = await idb(); return await new Promise(res => { const q = d.transaction('kv').objectStore('kv').get('${key}'); q.onsuccess = () => { d.close(); res(q.result); }; }); })()`);
const writeState = (page, s) => page.evaluate(`(async () => { ${IDB} const d = await idb(); await new Promise(res => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(${JSON.stringify(s)}, 'state'); tx.oncomplete = res; }); d.close(); })()`);
// The app checks the recall list once on opening and then saves its copy of the log. Wait for that before writing,
// or the app's save (even one from a check cut off by a reload) can land on top of what the test wrote.
const setState = async (page, s) => { for (let i = 0; i < 50 && !(await getState(page))?.recalls?.tried; i++) await page.waitForTimeout(100); await writeState(page, s); };
// Waits until the app's last save has reached IndexedDB, then reloads. A readwrite transaction on the same store
// only completes after the earlier ones, so a reload can't cut off a save that is still being written.
const settle = page => page.evaluate(`(async () => { ${IDB} const d = await idb(); await new Promise(res => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').get('state'); tx.oncomplete = res; }); d.close(); })()`);
const reload = async page => { await settle(page); await page.reload(); };
// Pages get an empty recall list unless a test answers with its own (the newest route wins).
const newPage = async () => { const page = await browser.newPage({ viewport: { width: 375, height: 800 } }); await page.route('**/processed.json', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' })); return page; };

for (const theme of ['night', 'day']) {
  const page = await newPage();
  page.on('pageerror', e => fail(`${theme}: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  { const s = await getState(page); s.settings.theme = theme; await setState(page, s); }
  await reload(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if ((await page.evaluate(() => document.documentElement.dataset.mode)) !== theme) fail(`${theme}: theme not applied`);
  if (await overflow()) fail(`${theme}: Today scrolls sideways`);

  // Breastfeeding timer starts and stops
  const timersBefore = await page.locator('.timer').count();
  await page.click('[data-add="feed"]');
  await page.click('.chips[data-k="kind"] [data-v="Breast"]');
  if (!(await page.isHidden('.chips[data-k="ml"]'))) fail(`${theme}: bottle amount shown for breastfeed`);
  await page.click('[data-act="start-timer"]');
  if ((await page.locator('.timer').count()) !== timersBefore + 1) fail(`${theme}: timer did not start`);
  await page.locator('.timer button').last().click();

  // Solids entry lands at the top of the timeline
  await page.click('[data-add="solids"]');
  await page.fill('#f_food', 'Apple');
  await page.click('[data-act="save-entry"]');
  if (!(await page.locator('.tl li').first().innerText()).includes('Apple')) fail(`${theme}: solids entry missing`);

  // Turning a tracker off hides its button and summary card; turning it back on restores them
  if (theme === 'night') {
    await page.click('[data-view="day"]');
    const tile = () => page.locator('.tile small', { hasText: 'Diapers' }).count();
    if ((await tile()) !== 1) fail('diaper card missing before customizing');
    await page.click('[data-act="track-sheet"]');
    await page.click('[data-track="diaper"]');
    await page.click('[data-act="close"]');
    if ((await tile()) !== 0 || (await page.locator('.quick [data-add="diaper"], .tl .t-diaper').count()) !== 0) fail('diaper still shown after turning it off');
    await reload(page);
    if ((await tile()) !== 0) fail('diaper setting not saved');
    await page.click('[data-act="track-sheet"]');
    await page.click('[data-track="diaper"]');
    await page.click('[data-act="close"]');
    if ((await tile()) !== 1) fail('diaper card not back after turning it on');
  }

  // While sick, Today switches between sick and everyday views without ending sick mode
  if (theme === 'night') {
    await page.click('[data-view="day"]');
    if ((await page.locator('.quick [data-add="symptom"]').count()) !== 0) fail('everyday view still shows sick buttons');
    if ((await page.locator('[data-view="sick"]').count()) !== 1) fail('everyday view lost the way back to sick view');
    await reload(page);
    if ((await page.locator('[data-view="day"].on').count()) !== 1) fail('view choice not remembered');
    await page.click('[data-view="sick"]');
    if ((await page.locator('.quick [data-add="symptom"]').count()) !== 1) fail('sick view missing sick buttons');
  }

  // Symptoms start as free text; preset tags add to the text and can be removed again
  if (theme === 'day') {
    await page.click('.tabs [data-tab="today"]');
    await page.click('.quick [data-add="symptom"]');
    await page.waitForTimeout(150);
    if ((await page.evaluate(() => document.activeElement?.id)) !== 'f_symtext') fail('symptom text box is not focused first');
    await page.fill('#f_symtext', 'Coughing at night');
    await page.click('#symTags [data-tag="Ear pain"]');
    await page.click('#symTags [data-tag="Rash"]');
    await page.click('#symTags [data-tag="Rash"]');
    const text = await page.inputValue('#f_symtext');
    if (text !== 'Coughing at night, ear pain') fail(`symptom text is "${text}"`);
    await page.click('[data-act="save-entry"]');
    const row = await page.locator('.tl li').first().innerText();
    if (!row.includes('Coughing at night, ear pain')) fail('symptom text missing from timeline');
    const saved = (await getState(page)).entries.filter(e => e.type === 'symptom').sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!saved.symptoms.includes('Ear pain')) fail('tag not kept for the doctor summary');
  }

  // Teeth and milestones on the Growth tab
  if (theme === 'night') {
    await page.click('.tabs [data-tab="growth"]');
    const teeth = () => page.locator('.tooth.in').count(), before = await teeth();
    await page.locator('.tooth:not(.in)').first().click();
    await page.click('[data-act="save-growth"]');
    if ((await teeth()) !== before + 1) fail('tooth not marked');
    await page.click('[data-ms="new"]');
    await page.fill('#g_label', 'First haircut');
    await page.click('[data-act="save-growth"]');
    if ((await page.locator('.ms-row', { hasText: 'First haircut' }).count()) !== 1) fail('custom milestone missing');
    await reload(page);
    await page.click('.tabs [data-tab="growth"]');
    if ((await teeth()) !== before + 1) fail('tooth not saved');
    await page.click('.tabs [data-tab="today"]');
  }

  // Sick view tabs, Growth and More
  await page.click('[data-act="open-sick"]');
  for (const t of ['overview', 'chart', 'doctor']) { await page.click(`[data-sick="${t}"]`); if (await overflow()) fail(`${theme}: sick ${t} scrolls sideways`); }
  for (const t of ['growth', 'vax', 'more']) { await page.click(`.tabs [data-tab="${t}"]`); if (await overflow()) fail(`${theme}: ${t} scrolls sideways`); }
  // The illness's name, start and notes can be changed from the sick card on Today
  if (theme === 'day') {
    await page.click('.tabs [data-tab="today"]');
    await page.click('.sick-card [data-act="edit-episode"]');
    const local = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
    const start = new Date(local(Date.now() - 4 * 864e5)).getTime();
    await page.fill('#f_title', 'Ear infection');
    await page.fill('#f_start', local(start));
    await page.fill('#f_epnote', 'Started after daycare');
    await page.click('[data-act="save-episode"]');
    await reload(page);
    const ep = (await getState(page)).episodes.find(e => !e.deleted && !e.end);
    if (ep?.title !== 'Ear infection' || ep.start !== start || ep.note !== 'Started after daycare') fail(`illness edit not saved: ${JSON.stringify(ep)}`);
    if (!(await page.locator('.sick-card').innerText()).includes('Ear infection')) fail('sick card does not show the new name');
    // A start in the future is refused and nothing changes
    await page.click('.sick-card [data-act="edit-episode"]');
    await page.fill('#f_start', local(Date.now() + 2 * 864e5));
    await page.click('[data-act="save-episode"]');
    if ((await getState(page)).episodes.find(e => e.id === ep.id).start !== start) fail('future illness start was saved');
    await page.click('[data-act="close"]');

    // Ending sick mode asks first (and when they got better), then Today returns to everyday tracking
    await page.click('[data-act="end-ask"]');
    await page.fill('#f_better', local(Date.now() - 864e5));
    await page.click('[data-act="end-episode"]');
    if ((await page.locator('.sick, .sick-card, [data-view]').count()) !== 0) fail('sick mode still shown after ending it');
    if ((await page.locator('[data-act="new-episode"]').count()) !== 1) fail('no way to start sick mode again');
    const end = (await getState(page)).episodes.find(e => e.id === ep.id).end;
    if (end !== new Date(local(Date.now() - 864e5)).getTime()) fail('chosen end time not saved');

    // A past illness's end can be changed under More, but not to before its start
    await page.click('.tabs [data-tab="more"]');
    await page.click(`[data-act="edit-episode"][data-for="${ep.id}"]`);
    await page.fill('#f_epend', local(start - 864e5));
    await page.click('[data-act="save-episode"]');
    if ((await getState(page)).episodes.find(e => e.id === ep.id).end !== end) fail('illness end before its start was saved');
    const end2 = new Date(local(start + 2 * 864e5)).getTime();
    await page.fill('#f_epend', local(end2));
    await page.click('[data-act="save-episode"]');
    const saved = (await getState(page)).episodes.find(e => e.id === ep.id);
    if (saved.end !== end2 || saved.note !== 'Started after daycare') fail(`past illness edit not saved: ${JSON.stringify(saved)}`);
    if (await overflow()) fail('More scrolls sideways with illness buttons');
  }
  await page.close();
}

// Sound recordings, saying it without AI, backups, and what the AI is sent
{
  const page = await newPage();
  page.on('pageerror', e => fail(`extras: ${e.message}`));
  // A stand-in for the claude.ai AI that records the prompt and answers with the placeholder.
  await page.addInitScript(() => { window.__sent = []; const sample = async p => { window.__sent.push(p); return { text: '[CHILD] has had a fever for three days.' }; }; sample.json = async p => { window.__sent.push(p); return { entries: [] }; }; window.claude = { use: async () => sample }; });
  await page.goto(url);
  await page.waitForSelector('h1');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

  // Record a short sound in sick mode; it plays back in the timeline and in the doctor view
  await page.click('.quick [data-add="sound"]');
  await page.click('[data-act="rec"]');
  await page.waitForTimeout(1500);
  await page.click('[data-act="rec"]');
  await page.waitForSelector('#recOut audio');
  await page.fill('#f_note', 'Whistling when breathing in');
  await page.click('[data-act="save-entry"]');
  if ((await page.locator('.tl .media audio').count()) < 1) fail('sound recording not in the timeline');
  if (await overflow()) fail('timeline with a recording scrolls sideways');
  // A link instead of a recording, and links that are not web addresses are refused
  await page.click('.quick [data-add="sound"]');
  await page.fill('#f_link', 'javascript:alert(1)');
  await page.click('[data-act="save-entry"]');
  if (!(await page.isVisible('#f_link'))) fail('unsafe link was accepted');
  await page.fill('#f_link', 'https://photos.example.com/v/123');
  await page.click('[data-act="save-entry"]');
  if ((await page.locator('.tl .media a[href="https://photos.example.com/v/123"]').count()) !== 1) fail('recording link missing');
  await page.click('[data-act="open-sick"]');
  await page.click('[data-sick="doctor"]');
  if ((await page.locator('.rec-item audio').count()) !== 1) fail('recording missing from the doctor view');

  // The AI handover is sent without the child's name, and the name comes back on the phone
  await page.click('[data-act="ai-summary"]');
  await page.waitForSelector('.narrative >> text=Mia has had a fever');
  const sent = await page.evaluate(() => window.__sent.join('\n'));
  if (/Mia/.test(sent) || !sent.includes('[CHILD]')) fail('child name was sent to the AI');
  if (/data:audio|photos\.example/.test(sent)) fail('recording sent to the AI');
  if ((await page.locator('details pre.sent').count()) !== 1) fail('no way to see what was sent');

  // Say it floats above the tab bar on Today (not on More) and can be saved as a plain note
  await page.click('.tabs [data-tab="today"]');
  if (!(await page.locator('#fab').isVisible())) fail('Say it button not shown on Today');
  await page.click('#fab');
  await page.fill('#aiText', 'Grandma visited');
  await page.click('[data-act="say-note"]');
  if (!(await page.locator('.tl li').first().innerText()).includes('Grandma visited')) fail('say it note not saved');

  // Backup file round trip: download, delete everything, restore
  await page.click('.tabs [data-tab="more"]');
  if (await overflow()) fail('More scrolls sideways');
  if (await page.locator('#fab').isVisible()) fail('Say it button shown on More');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="download"]')]);
  const file = await dl.path();
  await page.click('[data-act="wipe"]');
  await page.click('[data-act="wipe-yes"]');
  await page.click('.tabs [data-tab="more"]');
  await page.setInputFiles('#restoreFile', file);
  await page.waitForTimeout(300);
  const st = await getState(page);
  if (!st.entries.some(e => e.note === 'Grandma visited') || !st.children.some(c => c.name === 'Mia')) fail('backup file did not restore');
  if (!st.vaccines?.some(v => v.kind === 'dose' && v.against.includes('6in1'))) fail('backup file did not restore vaccinations');
  await page.close();
}

// Vaccinations: the schedule shows what is open, a dose from the book closes it, and book photos are kept
{
  const page = await newPage();
  page.on('pageerror', e => fail(`vaccines: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  // The example child (2 years) has everything up to 15 months except the third meningococcus B dose
  const line = () => page.locator('.vax-line').count();
  if ((await line()) !== 1 || !(await page.innerText('.vax-line')).includes('Meningococcus B')) fail('vaccines: Today does not point to the open dose');
  await page.click('.vax-line');
  if (await page.isHidden('#view-vax')) fail('vaccines: Today line does not open the Vaccines tab');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('vaccines: tab scrolls sideways');
  if ((await page.locator('.vx-row.late').count()) !== 1) fail('vaccines: expected exactly one dose past its usual age');
  if ((await page.locator('.vx-row.done').count()) !== 5) fail(`vaccines: expected 5 finished vaccines, got ${await page.locator('.vx-row.done').count()}`);
  // Not planned for us: the reminder goes away, and comes back when planned again
  await page.click('[data-vxitem="menb"]');
  await page.click('[data-act="vax-skip"]');
  await page.click('.tabs [data-tab="today"]');
  if ((await line()) !== 0) fail('vaccines: reminder shown for a vaccine marked not planned');
  await page.click('.tabs [data-tab="vax"]');
  await page.click('[data-vxitem="menb"]');
  await page.click('[data-act="vax-skip"]');
  // Adding the dose from the book closes it
  await page.click('[data-vxitem="menb"]');
  await page.click('#sheet [data-act="add-vax"]');
  if ((await page.locator('.chips[data-k="against"] [data-v="menb"].on').count()) !== 1) fail('vaccines: dose sheet not set to the vaccine tapped');
  await page.fill('#v_name', 'Bexsero'); await page.fill('#v_batch', 'XY123');
  await page.click('[data-act="save-vax"]');
  if ((await page.locator('.vx-row.late').count()) !== 0) fail('vaccines: dose did not close the open vaccine');
  // A future date is refused
  await page.click('[data-act="add-vax"]');
  await page.fill('#v_date', '2999-01-01');
  await page.click('.chips[data-k="against"] [data-v="flu"]');
  await page.click('[data-act="save-vax"]');
  if (await page.isHidden('#scrim')) fail('vaccines: a future date was saved');
  await page.click('[data-act="close"]');
  // A travel vaccine outside the schedule
  await page.click('[data-act="add-vax"]');
  await page.click('.chips[data-k="against"] [data-v="rabies"]');
  await page.click('[data-act="save-vax"]');
  if ((await page.locator('.vx-dose', { hasText: 'Rabies' }).count()) !== 1) fail('vaccines: travel vaccine not recorded');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('vaccines: tab scrolls sideways with a travel vaccine');
  // A photo of a page of the book
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#vaxPage', { name: 'page.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.book [data-vxpage]');
  await reload(page); await page.waitForSelector('h1');
  const st = await getState(page);
  const dose = st.vaccines.find(v => v.batch === 'XY123');
  if (!dose || !dose.updatedAt || dose.against.join() !== 'menb' || dose.name !== 'Bexsero') fail('vaccines: dose not saved');
  if (!st.vaccines.some(v => v.kind === 'page' && v.img?.startsWith('data:image/') && v.updatedAt)) fail('vaccines: book photo not saved');
  if (st.vaccines.some(v => v.against?.includes('flu'))) fail('vaccines: refused dose was saved');
  if ((await line()) !== 0) fail('vaccines: Today still points to a recorded dose');
  // The doctor summary mentions a vaccination given during the illness
  await page.click('[data-act="open-sick"]');
  await page.click('[data-sick="doctor"]');
  if (!(await page.innerText('.facts')).includes('Vaccinated')) fail('vaccines: doctor summary does not mention the recent vaccination');
  // Without a schedule only the records show
  await page.click('.tabs [data-tab="vax"]');
  await page.click('[data-vaxplan="none"]');
  if ((await page.locator('.vx-row').count()) !== 0) fail('vaccines: schedule shown with no schedule chosen');
  await page.click('.tabs [data-tab="today"]');
  await page.close();
}

// Backups are required: a new log asks for one and Today keeps reminding until a copy exists off the phone
{
  const page = await newPage();
  page.on('pageerror', e => fail(`backup: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  if ((await page.locator('.backup-due').count()) !== 0) fail('backup: reminder shown for example data');
  await page.click('[data-act="clear-example"]');
  await page.fill('#k_name', 'Ada');
  await page.click('[data-act="save-kid"]');
  if ((await page.locator('[data-act="backup-file"]').count()) !== 1) fail('backup: no backup choice after adding the first child');
  await page.click('[data-act="close"]');
  if ((await page.locator('.backup-due').count()) !== 1) fail('backup: no reminder on Today before the first backup');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('backup: reminder scrolls sideways');
  await page.click('[data-act="backup-now"]');
  await Promise.all([page.waitForEvent('download'), page.click('[data-act="backup-file"]')]);
  if ((await page.locator('.backup-due').count()) !== 0) fail('backup: reminder still shown after saving a backup');
  await page.close();
}

// AI through any OpenAI-style service the parent chooses, still without names
{
  const page = await newPage();
  page.on('pageerror', e => fail(`ai service: ${e.message}`));
  let body = null, auth = null;
  await page.route('https://ai.example.com/v1/chat/completions', async route => {
    body = route.request().postDataJSON(); auth = route.request().headers().authorization;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: '[CHILD] is on day 3.' } }] }) });
  });
  await page.goto(url);
  await page.waitForSelector('h1');
  await page.click('.tabs [data-tab="more"]');
  await page.click('[data-aikind="openai"]');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('ai service: More scrolls sideways');
  await page.fill('#aiBase', 'https://ai.example.com/v1'); await page.press('#aiBase', 'Tab');
  await page.fill('#aiModel', 'test-model'); await page.press('#aiModel', 'Tab');
  await page.fill('#apiKey', 'k123'); await page.press('#apiKey', 'Tab');
  await page.click('.tabs [data-tab="today"]');
  await page.click('[data-act="open-sick"]');
  await page.click('[data-sick="doctor"]');
  await page.click('[data-act="ai-summary"]');
  await page.waitForSelector('.narrative >> text=Mia is on day 3');
  if (!body || body.model !== 'test-model' || auth !== 'Bearer k123') fail('ai service: request not sent to the chosen service');
  if (JSON.stringify(body).includes('Mia')) fail('ai service: child name was sent');
  await page.close();
}

// Drive sync against a fake Drive: a second phone saving at the same moment, and a damaged Drive file
{
  const page = await newPage();
  page.on('pageerror', e => fail(`sync: ${e.message}`));
  await page.addInitScript(() => { window.google = { accounts: { oauth2: { initTokenClient: o => ({ requestAccessToken: () => o.callback({ access_token: 't', expires_in: 3600 }) }) } } }; });
  const other = (id, t) => ({ id, child: 'kid-ex', type: 'note', t, note: 'From the other phone', updatedAt: t });
  // "future" stands for a part added by a later version of the app without a format change; it must be kept.
  const drive = { file: { app: 'aura', v: 2, children: [], episodes: [], entries: [other('o1', 1000)], meds: [], measurements: [], growth: [], future: ['kept'] }, patches: 0, race: true, uploads: [], queries: [], version: 1, downloads: 0 };
  const setFile = f => { drive.file = f; drive.version++; }; // a change by someone else bumps Drive's version number
  await page.route('https://www.googleapis.com/**', async route => {
    const req = route.request(), u = new URL(req.url()), m = req.method();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: typeof b === 'string' ? b : JSON.stringify(b) });
    if (u.pathname.startsWith('/upload') && m === 'PATCH') {
      drive.patches++; drive.file = JSON.parse(req.postData()); const mine = String(++drive.version);
      // Another phone overwrites right after us with its own copy, which lacks our entries
      if (drive.race) { drive.race = false; setFile({ ...drive.file, entries: [other('o1', 1000), other('o2', 2000)] }); }
      return json({ version: mine });
    }
    if (u.pathname.startsWith('/upload') && m === 'POST') { drive.uploads.push(req.postData()); return json({ id: 'b' + drive.uploads.length }); }
    if (u.pathname === '/drive/v3/files/f1' && u.searchParams.get('alt') === 'media') { drive.downloads++; return json(drive.file); }
    if (u.pathname === '/drive/v3/files/f1') return json({ ownedByMe: true, parents: ['logdir'], version: String(drive.version) });
    if (u.pathname === '/drive/v3/files') drive.queries.push(u.searchParams.get('q') || '');
    if (u.pathname === '/drive/v3/files') return json({ files: (u.searchParams.get('q') || '').includes('in parents') ? [] : [{ id: 'folder' }] });
    return json({});
  });
  await page.goto(url);
  await page.waitForSelector('h1');
  const st = await getState(page); st.example = false; st.settings.clientId = 'x-y.apps.googleusercontent.com'; st.drive = { fileId: 'f1' };
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  await page.click('[data-act="sync-tap"]');
  await page.waitForSelector('.sync.ok');
  const mine = (await getState(page)).entries;
  if (!['o1', 'o2'].every(id => mine.some(e => e.id === id))) fail('sync: entry from the other phone not merged');
  if (!mine.every(e => drive.file.entries.some(x => x.id === e.id))) fail('sync: our entries lost after the other phone wrote');
  if (drive.patches !== 2) fail(`sync: expected a second write after the clash, got ${drive.patches}`);
  if (!drive.uploads.some(b => b.includes('aura-backup-'))) fail('sync: no backup saved before overwriting');
  if (!drive.queries.some(q => q.includes("name='backups'") && q.includes("'logdir' in parents"))) fail('sync: backups not kept next to the log (so a moved or renamed folder would lose them)');
  if (!drive.file.vaccines?.some(v => v.kind === 'dose')) fail('sync: vaccinations not written to Drive');
  if (drive.file.future?.[0] !== 'kept') fail('sync: a part of the Drive file this version does not know was dropped');
  // With nothing changed on either side, a sync only asks Drive for the version number and downloads nothing
  let downloads = drive.downloads, patches = drive.patches;
  const syncNow = async () => { await page.evaluate(() => { document.getElementById('toast').hidden = true; }); await page.click('[data-act="sync-tap"]'); await page.waitForSelector('#toast:not([hidden])'); };
  await syncNow();
  if (!(await page.locator('#toast').innerText()).startsWith('Synced')) fail('sync: no feedback after tapping sync');
  if (drive.downloads !== downloads || drive.patches !== patches) fail('sync: an idle sync downloaded or wrote the file');
  // A change by the other phone is picked up
  setFile({ ...drive.file, entries: [...drive.file.entries, other('o3', 3000)] });
  await syncNow();
  if (!(await getState(page)).entries.some(e => e.id === 'o3')) fail('sync: change from the other phone not picked up');
  // A log saved by a newer version of the app is never overwritten by this one
  setFile({ ...drive.file, v: 99 }); let before = drive.patches;
  await page.click('[data-act="sync-tap"]');
  await page.waitForSelector('.sync.err');
  if (drive.patches !== before || drive.file.v !== 99) fail('sync: a newer log in Drive was overwritten');
  // An older log in Drive is upgraded, after a copy of it as it was is kept as aura-log-before-v2.json
  setFile({ app: 'sick-day-log', v: 1, children: [], episodes: [], entries: [other('old1', 500)], meds: [], measurements: [] }); before = drive.uploads.length;
  await page.click('[data-act="sync-tap"]');
  await page.waitForSelector('.sync.ok');
  if (!drive.uploads.slice(before).some(b => b.includes('aura-log-before-v2.json') && b.includes('sick-day-log'))) fail('sync: no copy kept before upgrading the Drive log');
  if (drive.file.v !== 2 || !drive.file.entries.some(e => e.id === 'old1')) fail('sync: older Drive log not upgraded');
  // A damaged Drive file is never overwritten
  setFile('not json'); before = drive.patches;
  await page.click('[data-act="sync-tap"]');
  await page.waitForSelector('.sync.err');
  if (drive.patches !== before) fail('sync: damaged Drive file was overwritten');
  await page.close();
}

// A stored log with missing parts still opens, and nothing is lost on the next save
{
  const page = await newPage();
  page.on('pageerror', e => fail(`robust: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  const st = await getState(page); const n = st.entries.length; delete st.growth; delete st.measurements; st.settings = null;
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  await page.click('[data-add="note"]'); await page.fill('#f_note', 'Still works'); await page.click('[data-act="save-entry"]');
  const after = await getState(page);
  if (after.entries.length !== n + 1 || !Array.isArray(after.growth)) fail('robust: log with missing parts not repaired');
  await page.close();
}

// Data from the earlier Sick Day Log is migrated
{
  const page = await newPage();
  page.on('pageerror', e => fail(`migration: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  await page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('aura'); r.onsuccess = r.onerror = r.onblocked = res; }));
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sickdaylog.v1', JSON.stringify({ app: 'sick-day-log', v: 1, example: false,
    children: [{ id: 'c1', name: 'Leo', dob: '2025-01-01' }], episodes: [{ id: 'e1', childId: 'c1', start: Date.now() - 864e5, end: null }],
    entries: [{ id: 'x1', ep: 'e1', type: 'temp', t: Date.now() - 36e5, tempC: 38.8 }], meds: [], measurements: [], settings: { unit: 'C' } })); });
  await page.reload(); // the database was just deleted on purpose, so nothing to wait for
  if (!(await page.locator('h1').first().innerText()).includes('Leo')) fail('migration: child not carried over');
  if ((await page.locator('.sick-card').count()) !== 1) fail('migration: open illness not shown as sick mode');
  if ((await getState(page, 'before-v2'))?.app !== 'sick-day-log') fail('migration: no copy kept of the log before the upgrade');
  await page.close();
}

// A log saved by a newer version of the app is shown but never changed by this one
{
  const page = await newPage();
  page.on('pageerror', e => fail(`newer: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  const st = await getState(page); st.example = false; st.v = 99; const n = st.entries.length;
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  await page.click('[data-add="note"]'); await page.fill('#f_note', 'Should not be saved'); await page.click('[data-act="save-entry"]');
  const after = await getState(page);
  if (after.v !== 99 || after.entries.length !== n) fail('newer: a log from a newer version was changed');
  await page.close();
}

// Product recalls: the public list is loaded, products on the family's list are matched, and a warning shows until seen
{
  const page = await newPage();
  page.on('pageerror', e => fail(`recalls: ${e.message}`));
  const feed = [
    { id: 'https://example.org/r1', title: 'HiPP Bio Karotten mit Kartoffeln 190 g', url: 'https://example.org/r1', publish_datetime: new Date(Date.now() - 2 * 864e5).toISOString(), country_sold_in: 'DE', source: 'Lebensmittelwarnung.de', reason: { en: 'Foreign bodies', de: 'Fremdkörper' }, company: 'HiPP GmbH, Pfaffenhofen', scraped_datetime: new Date().toISOString() },
    { id: 'https://example.org/r2', title: 'Magic Sand', url: 'https://example.org/r2', publish_datetime: new Date(Date.now() - 5 * 864e5).toISOString(), country_sold_in: 'US', source: 'FDA', reason: 'Lead', company: 'Toys Inc', scraped_datetime: new Date().toISOString() },
  ];
  let calls = 0;
  await page.route('**/processed.json', r => { calls++; r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(feed) }); });
  await page.goto(url);
  await page.waitForSelector('h1');
  // A quiet line on Today opens the newest recalls; once seen, the line goes away
  await page.waitForSelector('.recall-line');
  if (!(await page.innerText('.recall-line')).startsWith('2 new')) fail('recalls: Today line does not count 2 new');
  await page.click('.recall-line');
  if ((await page.locator('#sheet .recall-row .new').count()) !== 2) fail('recalls: feed does not mark new recalls');
  await page.click('#sheet [data-act="close"]');
  if ((await page.locator('.recall-line').count()) !== 0) fail('recalls: Today line still shown after opening the feed');
  await reload(page); await page.waitForSelector('h1');
  if ((await page.locator('.recall-line').count()) !== 0) fail('recalls: Today line back after reload');
  await page.click('.tabs [data-tab="more"]');
  await page.waitForSelector('#recalls .recall-row');
  if ((await page.locator('#recalls .recall-row').count()) !== 2) fail('recalls: list not shown');
  // Countries to track: turning the USA off leaves the German recall, and the choice is kept
  await page.click('[data-rcountry="US"]');
  if ((await page.locator('#recalls .recall-row').count()) !== 1) fail('recalls: country filter not applied');
  await reload(page); await page.waitForSelector('h1'); await page.click('.tabs [data-tab="more"]');
  if ((await page.locator('[data-rcountry="US"].on').count()) !== 0 || (await page.locator('[data-rcountry="DE"].on').count()) !== 1) fail('recalls: country choice not saved');
  if ((await page.locator('#recalls .recall-row').count()) !== 1) fail('recalls: country filter lost after reload');
  await page.fill('#newProd', 'hipp');
  await page.click('[data-act="add-prod"]');
  if ((await page.locator('#recalls .hit').count()) !== 1) fail('recalls: product not matched');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('recalls: More scrolls sideways');
  await page.click('.tabs [data-tab="today"]');
  if ((await page.locator('.recall-due').count()) !== 1) fail('recalls: no warning on Today');
  await page.click('.recall-due [data-seen]');
  await reload(page); await page.waitForSelector('h1');
  if ((await page.locator('.recall-due').count()) !== 0) fail('recalls: warning back after Seen');
  if (calls !== 1) fail(`recalls: list fetched ${calls} times, expected once`);
  const st = await getState(page);
  if (!st.products.some(p => p.name === 'hipp' && p.updatedAt)) fail('recalls: product list not saved');
  await page.close();
}

await browser.close();
if (errors.length) { console.error('Smoke test failed:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log('Smoke test passed');
