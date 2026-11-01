// Opens the built app at phone width and checks the main screens render without errors or sideways scrolling.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

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
// Adds photos as pages of a document: the app first asks camera or photos, then the new page opens.
const choosePhoto = async (page, sel, files, how = 'lib') => { await page.click(sel); await Promise.all([page.waitForEvent('filechooser').then(fc => fc.setFiles(files)), page.click(`[data-pick="${how}"]`)]); };
const addPage = async (page, sel, files, how) => { await choosePhoto(page, sel, files, how); await page.waitForSelector('#pageImg'); };
// Pages get an empty recall list unless a test answers with its own (the newest route wins).
const newPage = async () => { const page = await browser.newPage({ viewport: { width: 375, height: 800 } }); await page.route('**/processed.json', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' })); return page; };
// Vaccinations and Checkups are opened from the Documents tab.
const openTab = async (page, t) => { if (['vax', 'checkups', 'dental'].includes(t)) { await page.click('.tabs [data-tab="docs"]'); await page.click(`#view-docs [data-tab="${t}"]`); } else await page.click(`.tabs [data-tab="${t}"]`); };

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

  // Sick mode keeps its own list: changing it leaves the everyday list alone, and each comes back with its view
  if (theme === 'night') {
    const kidOf = async () => (await getState(page)).children.find(k => !k.deleted);
    const everyday = JSON.stringify((await kidOf()).track);
    await page.click('[data-view="sick"]');
    await page.click('[data-act="track-sheet"]');
    if ((await page.locator('[data-trackmode="sick"].on').count()) !== 1) fail('sick view did not open the sick-mode list');
    await page.click('[data-track="vomit"]');
    await page.click('[data-track="feed"]');
    await page.click('[data-act="close"]');
    if ((await page.locator('.quick [data-add="vomit"], .quick [data-add="feed"]').count()) !== 0) fail('sick list change not shown in sick view');
    const k1 = await kidOf();
    if (JSON.stringify(k1.track) !== everyday || k1.trackSick?.vomit !== false || k1.trackSick?.feed !== false) fail(`sick list not kept apart: ${JSON.stringify([k1.track, k1.trackSick])}`);
    await page.click('[data-view="day"]');
    if ((await page.locator('.quick [data-add="feed"]').count()) !== 1) fail('everyday feed button lost after changing the sick list');
    await page.click('[data-act="track-sheet"]');
    if ((await page.locator('[data-trackmode="day"].on').count()) !== 1) fail('everyday view did not open the everyday list');
    await page.click('[data-trackmode="sick"]');
    if ((await page.getAttribute('[data-track="vomit"]', 'aria-checked')) !== 'false') fail('sick list not shown from the switch');
    await page.click('[data-act="track-reset"]');
    await page.click('[data-act="close"]');
    if ((await kidOf()).trackSick) fail('sick list not reset to suggestions');
    await reload(page);
    await page.click('[data-view="sick"]');
    if ((await page.locator('.quick [data-add="vomit"]').count()) !== 1) fail('sick suggestions not back after reset');
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
    if ((await page.locator('svg.curve').count()) < 2) fail('example child has no WHO percentile curves');
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
  for (const t of ['growth', 'docs', 'vax', 'checkups', 'dental', 'more']) { await openTab(page, t); if (await overflow()) fail(`${theme}: ${t} scrolls sideways`); }
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
  await openTab(page, 'vax');
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
  await addPage(page, '#view-vax [data-act="doc-add"] >> nth=0', { name: 'page.png', mimeType: 'image/png', buffer: png });
  await page.click('#sheet [data-act="close"]');
  await page.waitForSelector('#view-vax .book [data-pg]');
  await reload(page); await page.waitForSelector('h1');
  const st = await getState(page);
  const dose = st.vaccines.find(v => v.batch === 'XY123');
  if (!dose || !dose.updatedAt || dose.against.join() !== 'menb' || dose.name !== 'Bexsero') fail('vaccines: dose not saved');
  if (!st.pages.some(p => p.docId === 'vax-' + st.child && p.img?.startsWith('data:image/') && p.updatedAt) || !st.docs.some(d => d.id === 'vax-' + st.child && d.type === 'vax')) fail('vaccines: page of the book not saved');
  if (st.vaccines.some(v => v.against?.includes('flu'))) fail('vaccines: refused dose was saved');
  if ((await line()) !== 0) fail('vaccines: Today still points to a recorded dose');
  // The doctor summary mentions a vaccination given during the illness
  await page.click('[data-act="open-sick"]');
  await page.click('[data-sick="doctor"]');
  if (!(await page.innerText('.facts')).includes('Vaccinated')) fail('vaccines: doctor summary does not mention the recent vaccination');
  // Without a schedule only the records show
  await openTab(page, 'vax');
  await page.click('[data-vaxplan="none"]');
  if ((await page.locator('#view-vax .vx-row').count()) !== 0) fail('vaccines: schedule shown with no schedule chosen');
  await page.click('.tabs [data-tab="today"]');
  await page.close();
}

// Checkups (U-Heft): recorded ones, a due one on Today, recording it (with measurements for Growth), and calendar dates
{
  const page = await newPage();
  page.on('pageerror', e => fail(`checkups: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  if ((await page.locator('.vax-line', { hasText: 'checkup' }).count()) !== 0) fail('checkups: Today shows a checkup for the example child, whose next one is months away');
  await openTab(page, 'checkups');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('checkups: tab scrolls sideways');
  if ((await page.locator('[data-uitem].done').count()) !== 7) fail(`checkups: expected U1 to U7 done, got ${await page.locator('[data-uitem].done').count()}`);
  if ((await page.locator('[data-uitem="U7a"].later').count()) !== 1) fail('checkups: U7a not shown as later');
  const icsOf = async click => { const [dl] = await Promise.all([page.waitForEvent('download'), page.click(click)]); return readFileSync(await dl.path(), 'utf8'); };
  // One checkup: a Google Calendar link and a calendar file with one all-day event
  await page.click('[data-uitem="U7a"]');
  await page.click('[data-act="cal-u"]');
  const g = new URL(await page.getAttribute('[data-gcal]', 'href'));
  if (g.searchParams.get('action') !== 'TEMPLATE' || !g.searchParams.get('text').startsWith('U7a checkup · Mia') || !/^\d{8}\/\d{8}$/.test(g.searchParams.get('dates'))) fail('checkups: Google Calendar link is wrong');
  let ics = await icsOf('[data-act="cal-ics"]');
  if ((ics.match(/BEGIN:VEVENT/g) || []).length !== 1 || !/DTSTART;VALUE=DATE:\d{8}/.test(ics) || !ics.includes('SUMMARY:U7a checkup · Mia') || !ics.includes('\r\n')) fail('checkups: calendar file for one checkup is wrong');
  if (ics.split('\r\n').some(l => l.length > 75)) fail('checkups: calendar file has lines that are too long');
  // The next dates together: the U7a, the Z4 dental checkup and the open meningococcus B dose
  await page.click('[data-act="cal-next"]');
  if ((await page.locator('[data-gcal]').count()) !== 0) fail('checkups: Google link offered for several dates');
  ics = await icsOf('[data-act="cal-ics"]');
  if ((ics.match(/BEGIN:VEVENT/g) || []).length !== 3 || !ics.includes('Meningococcus B vaccination') || !ics.includes('SUMMARY:Z4 dental checkup · Mia')) fail('checkups: calendar file of the next dates is wrong');
  // A vaccination due later can go into the calendar too
  await openTab(page, 'vax');
  await page.click('[data-vxitem="menb"]');
  await page.click('[data-act="cal-vax"]');
  if (!(await page.getAttribute('[data-gcal]', 'href')).includes('Meningococcus')) fail('checkups: vaccination calendar link is wrong');
  await page.click('[data-act="close"]');
  // A baby of six months: the U5 is due, Today says so, and recording it closes it
  const dob = new Date(Date.now() - 6.3 * 30.44 * 864e5).toISOString().slice(0, 10);
  { const st = await getState(page); st.example = false; st.children.push({ id: 'kid-b', name: 'Ben', dob, updatedAt: Date.now() }); st.child = 'kid-b'; await setState(page, st); }
  await reload(page); await page.waitForSelector('h1');
  const uLine = page.locator('.vax-line', { hasText: 'U5 checkup due' });
  if ((await uLine.count()) !== 1) fail('checkups: Today does not show the due U5');
  await uLine.click();
  if (await page.isHidden('#view-checkups')) fail('checkups: Today line does not open the Checkups tab');
  if ((await page.locator('[data-uitem].missed').count()) !== 4) fail(`checkups: expected U1 to U4 as not recorded, got ${await page.locator('[data-uitem].missed').count()}`);
  await page.click('[data-uitem="U5"]');
  await page.click('#sheet [data-act="add-u"]');
  if ((await page.locator('.chips[data-k="u"] [data-v="U5"].on').count()) !== 1) fail('checkups: sheet not set to the checkup tapped');
  await page.fill('#u_date', '2999-01-01');
  await page.click('[data-act="save-u"]');
  if (await page.isHidden('#scrim')) fail('checkups: a future date was saved');
  await page.fill('#u_date', new Date().toISOString().slice(0, 10));
  await page.fill('#u_by', 'Dr. Weber'); await page.fill('#u_note', 'All fine'); await page.fill('#u_weightKg', '7.4');
  await page.click('[data-act="save-u"]');
  if ((await page.locator('[data-uitem="U5"].done').count()) !== 1) fail('checkups: recording the U5 did not close it');
  await page.click('.tabs [data-tab="today"]');
  if ((await page.locator('.vax-line', { hasText: 'U5' }).count()) !== 0) fail('checkups: Today still shows the recorded U5');
  let st = await getState(page);
  const ex = st.checkups.find(x => x.childId === 'kid-b' && x.u === 'U5'), m = ex && st.measurements.find(x => x.id === ex.measId);
  if (!ex || ex.by !== 'Dr. Weber' || ex.note !== 'All fine' || !ex.updatedAt) fail('checkups: checkup not saved');
  if (!m || m.weightKg !== 7.4 || m.childId !== 'kid-b' || m.deleted) fail('checkups: weight from the checkup not saved for Growth');
  // Clearing the weight again removes that measurement
  await openTab(page, 'checkups');
  await page.click(`[data-uexam="${ex.id}"]`);
  await page.fill('#u_weightKg', '');
  await page.click('[data-act="save-u"]');
  st = await getState(page);
  if (!st.measurements.find(x => x.id === ex.measId)?.deleted) fail('checkups: cleared weight still kept');
  // A photo of a page of the U-Heft
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await addPage(page, '#view-checkups [data-act="doc-add"] >> nth=0', { name: 'page.png', mimeType: 'image/png', buffer: png });
  await page.click('#sheet [data-act="close"]');
  await page.waitForSelector('#view-checkups .book [data-pg]');
  st = await getState(page);
  if (!st.pages.some(p => p.docId === 'u-kid-b' && p.childId === 'kid-b' && p.img?.startsWith('data:image/'))) fail('checkups: page of the U-Heft not saved');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('checkups: tab scrolls sideways with records');
  // Without a schedule only the records show
  await page.click('[data-uplan="none"]');
  if ((await page.locator('[data-uitem]').count()) !== 0) fail('checkups: schedule shown with no schedule chosen');
  await page.close();
}

// Dental checkups (Z1 to Z6): the schedule, the link with the teeth on Growth, a visit that adds teeth, the dental pass
{
  const page = await newPage();
  page.on('pageerror', e => fail(`dental: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  if ((await page.locator('.vax-line', { hasText: 'dental' }).count()) !== 0) fail('dental: Today shows a dental checkup for the example child, whose next one is months away');
  // Growth links to the dental checkups, and the Documents tab lists them
  await page.click('.tabs [data-tab="growth"]');
  await page.click('#view-growth [data-tab="dental"]');
  if (await page.isHidden('#view-dental')) fail('dental: the teeth on Growth do not open the dental checkups');
  if ((await page.locator('.tabs [data-tab="docs"][aria-selected="true"]').count()) !== 1) fail('dental: Documents tab not lit');
  if ((await page.locator('[data-zitem].done').count()) !== 3 || (await page.locator('[data-zitem="Z4"].later').count()) !== 1) fail('dental: expected Z1 to Z3 done and Z4 later');
  if ((await page.locator('#view-dental .tooth.in').count()) !== 16) fail('dental: tooth map not shown with the checkups');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('dental: screen scrolls sideways');
  await page.click('[data-zitem="Z4"]');
  await page.click('#sheet [data-act="cal-z"]');
  if (!new URL(await page.getAttribute('[data-gcal]', 'href')).searchParams.get('text').startsWith('Z4 dental checkup · Mia')) fail('dental: Google Calendar link is wrong');
  await page.click('[data-act="close"]');
  await page.click('.tabs [data-tab="docs"]');
  if (!(await page.innerText('#view-docs [data-tab="dental"]')).includes('Z3')) fail('dental: Documents row lacks the last checkup');
  // A baby of seven months with two teeth: the Z1 is due, and the visit adds a tooth the dentist saw
  const dob = new Date(Date.now() - 7.2 * 30.44 * 864e5).toISOString().slice(0, 10);
  { const st = await getState(page); st.example = false; st.children.push({ id: 'kid-z', name: 'Ben', dob, updatedAt: Date.now() }); st.child = 'kid-z';
    st.growth.push({ id: 't1', childId: 'kid-z', kind: 'tooth', key: 'L-A', t: Date.now() - 20 * 864e5, note: '', updatedAt: 1 }); await setState(page, st); }
  await reload(page); await page.waitForSelector('h1');
  const zl = page.locator('.vax-line', { hasText: 'Z1 dental checkup due' });
  if ((await zl.count()) !== 1) fail('dental: Today does not show the due Z1');
  await zl.click();
  await page.click('[data-zitem="Z1"]');
  await page.click('#sheet [data-act="add-z"]');
  if ((await page.locator('.chips[data-k="z"] [data-v="Z1"].on').count()) !== 1) fail('dental: sheet not set to the checkup tapped');
  if ((await page.locator('#sheet .tooth.in[disabled]').count()) !== 1) fail('dental: tooth already in not shown in the visit');
  await page.click('#sheet [data-zt="L-B"]');
  await page.fill('#z_by', 'Dr. Zahn'); await page.check('#z_fl');
  await page.click('[data-act="save-z"]');
  if ((await page.locator('[data-zitem="Z1"].done').count()) !== 1) fail('dental: recording the Z1 did not close it');
  const st = await getState(page), ex = st.dental.find(x => x.childId === 'kid-z' && x.z === 'Z1');
  if (!ex || ex.by !== 'Dr. Zahn' || !ex.fluoride || ex.teeth !== 2 || !ex.updatedAt) fail('dental: visit not saved');
  if (!st.growth.some(g => g.childId === 'kid-z' && g.kind === 'tooth' && g.key === 'L-B' && !g.deleted)) fail('dental: tooth seen at the visit not added under Growth');
  await page.click('.tabs [data-tab="today"]');
  if ((await page.locator('.vax-line', { hasText: 'dental' }).count()) !== 0) fail('dental: Today still shows the recorded Z1');
  // A page of the dental pass
  await openTab(page, 'dental');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await addPage(page, '#view-dental [data-act="doc-add"] >> nth=0', { name: 'page.png', mimeType: 'image/png', buffer: png });
  await page.click('#sheet [data-act="close"]');
  await page.waitForSelector('#view-dental .book [data-pg]');
  if (!(await getState(page)).pages.some(p => p.docId === 'z-kid-z')) fail('dental: page of the dental pass not saved');
  await page.click('[data-zplan="none"]');
  if ((await page.locator('[data-zitem]').count()) !== 0) fail('dental: schedule shown with no schedule chosen');
  await page.close();
}

// Appointments: a booked date and note show instead of the usual time, go to the calendar at their time, ask to be
// recorded once passed, and start the recorded visit on that day
{
  const page = await newPage();
  page.on('pageerror', e => fail(`appointments: ${e.message}`));
  const day = n => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  await page.goto(url);
  await page.waitForSelector('h1');
  await openTab(page, 'dental');
  await page.click('[data-zitem="Z4"]');
  await page.click('#sheet [data-act="appt"]');
  await page.click('[data-act="save-appt"]');
  if (await page.isHidden('#scrim') || (await page.locator('#a_date').count()) !== 1) fail('appointments: saved without a date');
  await page.fill('#a_date', day(5)); await page.fill('#a_time', '09:30'); await page.fill('#a_place', 'Zahnarztpraxis, Hauptstr. 3'); await page.fill('#a_note', 'Dr. Zahn');
  await page.click('[data-act="save-appt"]');
  // Saving offers the calendar right away, with the time, the place, the note and a link back
  if ((await page.locator('#sheet h2', { hasText: 'Appointment saved' }).count()) !== 1) fail('appointments: saving does not offer the calendar');
  const g = new URL(await page.getAttribute('[data-gcal]', 'href'));
  if (g.searchParams.get('dates') !== `${day(5).replace(/-/g, '')}T093000/${day(5).replace(/-/g, '')}T103000` || !g.searchParams.get('details').includes('Dr. Zahn')
    || g.searchParams.get('location') !== 'Zahnarztpraxis, Hauptstr. 3' || !g.searchParams.get('details').includes('?open=appts')) fail('appointments: Google Calendar link does not use the appointment');
  const gd = g.searchParams.get('details');
  if (g.searchParams.get('text') !== '🦷 Z4 dental checkup · Mia' || !gd.startsWith("Mia's Z4 dental checkup appointment") || !gd.includes('📍 Zahnarztpraxis') || !gd.includes('📝 Dr. Zahn') || !gd.includes('Bring:\n• Dental pass or U-Heft') || !/can be done until/.test(gd)) fail('appointments: calendar entry not filled in');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="cal-ics"]')]);
  const ics = readFileSync(await dl.path(), 'utf8');
  if (!ics.includes(`DTSTART:${day(5).replace(/-/g, '')}T093000`) || !ics.includes('TRIGGER:-PT1H') || !ics.includes('TRIGGER:-P1D') || !ics.includes('LOCATION:Zahnarztpraxis\\, Hauptstr. 3') || !ics.includes('TRANSP:OPAQUE')) fail('appointments: calendar file does not use the appointment');
  await page.click('[data-zitem="Z4"]');
  if (!(await page.innerText('#sheet .appt')).includes('Dr. Zahn')) fail('appointments: the checkup sheet does not show the appointment');
  await page.click('#sheet [data-act="close"]');
  const row = await page.innerText('[data-zitem="Z4"]');
  if ((await page.locator('[data-zitem="Z4"].booked').count()) !== 1 || !row.includes('Appointment') || !row.includes('Dr. Zahn') || /month 34/.test(row)) fail('appointments: the row still shows the usual time');
  let st = await getState(page), a = st.appts.find(x => x.k === 'Z4');
  if (!a || a.plan !== 'z' || a.date !== day(5) || a.time !== '09:30' || a.childId !== st.child || !a.updatedAt) fail('appointments: not saved');
  await page.click('.tabs [data-tab="today"]');
  if ((await page.locator('.vax-line', { hasText: 'Z4 dental checkup: appointment' }).count()) !== 1) fail('appointments: Today does not show the coming appointment');
  // A vaccination dose can be booked and the booking deleted again
  await openTab(page, 'vax');
  await page.click('[data-vxitem="menb"]');
  await page.click('#sheet [data-act="appt"]');
  await page.fill('#a_date', day(40));
  await page.click('[data-act="save-appt"]');
  await page.click('#sheet [data-act="close"]');
  if ((await page.locator('[data-vxitem="menb"].booked').count()) !== 1) fail('appointments: vaccination not shown as booked');
  st = await getState(page);
  if (!st.appts.some(x => x.plan === 'vax' && x.ks?.includes('menb') && x.doses?.menb >= 1 && !x.deleted)) fail('appointments: vaccination appointment not saved for its dose');
  await page.click('[data-vxitem="menb"]');
  await page.click('#sheet .appt [data-act="appt"]');
  await page.click('[data-act="del-appt"]');
  if ((await page.locator('[data-vxitem="menb"].booked').count()) !== 0) fail('appointments: deleted appointment still shown');
  await page.click('#sheet [data-act="close"]');
  // Once the day has passed, Auri asks to record it, and the visit starts on that day
  st = await getState(page); st.appts.find(x => x.k === 'Z4').date = day(-3); await setState(page, st);
  await reload(page); await page.waitForSelector('h1');
  if ((await page.locator('.vax-line', { hasText: 'Z4 dental checkup: appointment was' }).count()) !== 1) fail('appointments: Today does not ask to record a passed appointment');
  await openTab(page, 'dental');
  if ((await page.locator('[data-zitem="Z4"].went').count()) !== 1) fail('appointments: passed appointment not shown');
  await page.click('[data-zitem="Z4"]');
  await page.click('#sheet [data-act="add-z"]');
  if ((await page.inputValue('#z_date')) !== day(-3)) fail('appointments: the visit does not start on the appointment day');
  await page.click('[data-act="save-z"]');
  if ((await page.locator('[data-zitem="Z4"].done').count()) !== 1) fail('appointments: recording the visit did not close it');
  await page.click('.tabs [data-tab="today"]');
  if ((await page.locator('.vax-line', { hasText: 'Z4' }).count()) !== 0) fail('appointments: Today still shows the recorded visit');
  await page.close();
}

// Vaccination appointments: one appointment for several vaccines, from the Vaccinations screen, recorded afterwards
{
  const page = await newPage();
  page.on('pageerror', e => fail(`vaccination appointments: ${e.message}`));
  const day = n => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  await page.goto(url);
  await page.waitForSelector('h1');
  await openTab(page, 'vax');
  await page.click('#view-vax [data-act="appt"][data-plan="vax"]');
  if ((await page.locator('.chips[data-k="vks"] [data-v="menb"].on').count()) !== 1) fail('vaccination appointments: the vaccination due now is not ticked');
  await page.click('.chips[data-k="vks"] [data-v="flu"]');
  await page.fill('#a_date', day(3)); await page.fill('#a_time', '10:00'); await page.fill('#a_note', 'Dr. Weber');
  await page.click('[data-act="save-appt"]');
  await page.click('#sheet [data-act="close"]');
  const card = await page.innerText('#view-vax .card:has(h2:text("Appointments"))').catch(() => '');
  if (!card.includes('Meningococcus B, Flu') || !card.includes('Dr. Weber')) fail('vaccination appointments: not listed on the Vaccinations screen');
  if ((await page.locator('[data-vxitem="menb"].booked').count()) !== 1) fail('vaccination appointments: the vaccine row does not show the appointment');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('vaccination appointments: screen scrolls sideways');
  let st = await getState(page);
  const a = st.appts.find(x => x.plan === 'vax' && !x.deleted);
  if (!a || a.ks.join() !== 'menb,flu' || !(a.doses.menb >= 1) || a.doses.flu !== undefined || a.time !== '10:00') fail('vaccination appointments: not saved');
  await page.click('.tabs [data-tab="today"]');
  if ((await page.locator('.vax-line', { hasText: 'Vaccination (Meningococcus B, Flu): appointment' }).count()) !== 1) fail('vaccination appointments: Today does not show it');
  if ((await page.locator('.vax-line', { hasText: 'to check' }).count()) !== 0) fail('vaccination appointments: a booked vaccination is still to check');
  await openTab(page, 'checkups');
  await page.click('[data-act="cal-next"]');
  if ((await page.locator('#sheet .vx-dose', { hasText: 'Meningococcus B, Flu' }).count()) !== 1) fail('vaccination appointments: calendar has it more or less than once');
  await page.click('#sheet [data-act="close"]');
  // Once the day has passed, the vaccinations are recorded from the appointment
  st.appts.find(x => x.id === a.id).date = day(-2); await setState(page, st);
  await reload(page); await page.waitForSelector('h1');
  if ((await page.locator('.vax-line', { hasText: 'appointment was' }).count()) !== 1) fail('vaccination appointments: Today does not ask to record it');
  await openTab(page, 'vax');
  await page.click(`#view-vax [data-appt="${a.id}"]`);
  await page.click('[data-act="appt-record"]');
  if ((await page.inputValue('#v_date')) !== day(-2) || (await page.locator('.chips[data-k="against"] button.on').count()) !== 2) fail('vaccination appointments: recording does not start from the appointment');
  await page.click('[data-act="save-vax"]');
  if ((await page.locator('#view-vax [data-appt]').count()) !== 0 || (await page.locator('[data-vxitem="menb"].booked, [data-vxitem="menb"].went').count()) !== 0) fail('vaccination appointments: still open after recording');
  // An appointment saved by the first version (one vaccine, `k` and `dose`) still shows
  st = await getState(page); const n = st.vaccines.filter(d => !d.deleted && d.childId === st.child && d.against?.includes('rota')).length;
  st.appts.push({ id: 'old', childId: st.child, plan: 'vax', k: 'rota', dose: n + 1, date: day(9), time: '', note: '', updatedAt: Date.now() }); await setState(page, st);
  await reload(page); await page.waitForSelector('h1');
  await openTab(page, 'vax');
  if ((await page.locator('#view-vax [data-appt="old"]').count()) !== 1) fail('vaccination appointments: an appointment from the first version is not shown');
  await page.close();
}

// Appointments screen: every booked appointment in one list, any other appointment, linked to a document
{
  const page = await newPage();
  page.on('pageerror', e => fail(`appointments screen: ${e.message}`));
  const day = n => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  await page.goto(url);
  await page.waitForSelector('h1');
  { const st = await getState(page); st.docs.push({ id: 'd1', childId: st.child, type: 'other', title: 'Allergy pass', note: '', updatedAt: Date.now() }); await setState(page, st); }
  await reload(page); await page.waitForSelector('h1');
  // From a document: the appointment is linked to it
  await page.click('.tabs [data-tab="docs"]');
  await page.click('#view-docs [data-docid="d1"]');
  await page.click('#sheet [data-act="appt"][data-plan="other"]');
  if ((await page.inputValue('#a_doc')) !== 'd1') fail('appointments screen: appointment from a document not linked to it');
  await page.click('[data-act="save-appt"]');
  if (await page.isHidden('#scrim')) fail('appointments screen: saved without saying what for');
  await page.fill('#a_title', 'Allergy test'); await page.fill('#a_date', day(4)); await page.fill('#a_time', '08:15'); await page.fill('#a_note', 'Dr. Haut');
  await page.click('[data-act="save-appt"]');
  await page.click('#sheet [data-act="close"]');
  let st = await getState(page);
  const a = st.appts.find(x => x.plan === 'other');
  if (!a || a.title !== 'Allergy test' || a.docId !== 'd1' || a.date !== day(4) || a.time !== '08:15') fail('appointments screen: other appointment not saved');
  if (!(await page.innerText('#view-docs [data-tab="appts"]')).includes('Allergy test')) fail('appointments screen: Documents row does not show the next appointment');
  await page.click('#view-docs [data-tab="appts"]');
  if (await page.isHidden('#view-appts') || (await page.locator('.tabs [data-tab="docs"][aria-selected="true"]').count()) !== 1) fail('appointments screen: does not open under Documents');
  // A checkup booked from here shows in the same list
  await page.click('[data-act="appt-new"]');
  await page.click('[data-act="appt-pick"][data-plan="u"]');
  await page.click('#sheet [data-act="appt"][data-for="U7a"]');
  await page.fill('#a_date', day(20));
  await page.click('[data-act="save-appt"]');
  await page.click('#sheet [data-act="close"]');
  const list = await page.innerText('#view-appts');
  if (!list.includes('Allergy test') || !list.includes('Allergy pass') || !list.includes('U7a checkup') || list.indexOf('Allergy test') > list.indexOf('U7a checkup')) fail('appointments screen: list wrong or not in date order');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('appointments screen: scrolls sideways');
  await page.click('[data-act="cal-appts"]');
  if ((await page.locator('#sheet .vx-dose').count()) !== 2) fail('appointments screen: calendar does not have both appointments');
  await page.click('#sheet [data-act="close"]');
  await page.click(`#view-appts [data-appt="${a.id}"]`);
  await page.click('#sheet [data-act="cal-appt"]');
  if (new URL(await page.getAttribute('[data-gcal]', 'href')).searchParams.get('dates') !== `${day(4).replace(/-/g, '')}T081500/${day(4).replace(/-/g, '')}T091500`) fail('appointments screen: calendar link wrong');
  await page.click('#sheet [data-act="close"]');
  await page.click('.tabs [data-tab="today"]');
  if ((await page.locator('.vax-line', { hasText: 'Allergy test: appointment' }).count()) !== 1) fail('appointments screen: Today does not show it');
  // Once its day has passed it moves to Past
  st = await getState(page); st.appts.find(x => x.id === a.id).date = day(-1); await setState(page, st);
  await reload(page); await page.waitForSelector('h1');
  if ((await page.locator('.vax-line', { hasText: 'Allergy test' }).count()) !== 0) fail('appointments screen: Today still shows a past appointment');
  await page.click('.tabs [data-tab="docs"]'); await page.click('#view-docs [data-tab="appts"]');
  if (!(await page.innerText('#view-appts details')).includes('Past (1)')) fail('appointments screen: past appointment not under Past');
  await page.close();
}

// Emergency card: shown from Today, in English or German, edited, merged when two phones each started one, and in the doctor summary
{
  const page = await newPage();
  page.on('pageerror', e => fail(`card: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  // The card button sits next to the child at the top of every main screen and the sick view
  for (const t of ['growth', 'docs', 'vax', 'checkups', 'dental', 'more']) { await openTab(page, t); if ((await page.locator(`#view-${t} .head .sos`).count()) !== 1) fail(`card: no card button on ${t}`); }
  await page.click('.tabs [data-tab="today"]');
  await page.click('[data-act="open-sick"]');
  if ((await page.locator('#view-sick .head .sos').count()) !== 1) fail('card: no card button in the sick view');
  await page.click('#view-sick [data-tab="today"]');
  await page.click('#view-today .head .sos');
  if (await page.isHidden('#view-card')) fail('card: the button does not open the card');
  if (!(await page.innerText('.ec-allergy')).includes('Penicillin')) fail('card: allergy missing on the card');
  if ((await page.locator('#view-card a[href="tel:01712345678"]').count()) !== 1) fail('card: contact phone number is not a call link');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('card: scrolls sideways');
  await page.click('#view-card [data-doclang="de"]');
  const de = (await page.innerText('#view-card .ec')).toLowerCase();
  if (!de.includes('allergien') || !de.includes('notfallkontakte') || !de.includes('blutgruppe')) fail('card: German labels missing');
  await page.click('#view-card [data-doclang="en"]');
  // Editing keeps what was there and saves the change
  await page.click('[data-act="card-edit"]');
  if ((await page.inputValue('#ec_insurer')) !== 'Techniker Krankenkasse') fail('card: edit form does not show the saved card');
  await page.fill('#ec_allergies', 'Peanuts (hives)\nPenicillin');
  await page.fill('#ec_conditions', 'Asthma');
  await page.click('.chips[data-k="blood"] [data-v="O-"]');
  await page.click('[data-act="save-card"]');
  if (!(await page.innerText('#view-card .ec')).includes('O−')) fail('card: blood group not shown');
  let st = await getState(page);
  const live = st.emergency.filter(x => !x.deleted);
  if (live.length !== 1 || live[0].allergies !== 'Peanuts (hives)\nPenicillin' || live[0].blood !== 'O-' || !live[0].updatedAt) fail('card: change not saved');
  // The doctor summary lists allergies and conditions, in German too
  await page.click('.tabs [data-tab="today"]');
  await page.click('[data-act="open-sick"]');
  await page.click('[data-sick="doctor"]');
  if (!(await page.innerText('.facts')).includes('Allergies: Peanuts (hives); Penicillin.') || !(await page.innerText('.facts')).includes('Known conditions: Asthma.')) fail('card: doctor summary lacks allergies or conditions');
  await page.click('[data-doclang="de"]');
  if (!(await page.innerText('.facts')).includes('Allergien: Peanuts')) fail('card: German doctor summary lacks allergies');
  await page.click('[data-doclang="en"]');
  // A card started on another phone at the same time is shown merged, and the next save keeps one
  st = await getState(page); st.example = false;
  st.emergency.push({ id: 'other', childId: 'kid-ex', allergies: '', contacts: '', doctor: '', meds: 'Inhaler when wheezing', updatedAt: 1 });
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  await page.click('#view-today .head .sos');
  if (!(await page.innerText('#view-card .ec')).includes('Inhaler when wheezing') || !(await page.innerText('#view-card .ec')).includes('Peanuts')) fail('card: two cards for one child not merged');
  await page.click('[data-act="card-edit"]');
  await page.click('[data-act="save-card"]');
  st = await getState(page);
  const kept = st.emergency.filter(x => !x.deleted);
  if (kept.length !== 1 || kept[0].meds !== 'Inhaler when wheezing' || !kept[0].allergies.includes('Peanuts')) fail('card: merged save lost something');
  if (!st.emergency.some(x => x.id === 'other' && x.deleted)) fail('card: the merged card was not marked as replaced');
  // The tab bar fills the full width, with the last tab ending near the right edge
  { const r = await page.evaluate(() => { const b = [...document.querySelectorAll('.tabs button')].pop().getBoundingClientRect(); return innerWidth - b.right; }); if (r > 20) fail(`tabs: ${Math.round(r)} px empty on the right of the tab bar`); }
  // The Documents tab holds the card, the vaccination book, the U-Heft and other papers
  await page.click('.tabs [data-tab="docs"]');
  if (!(await page.innerText('#view-docs .vx-row[data-card]')).includes('Peanuts')) fail('documents tab: card row lacks the allergies');
  if (!(await page.innerText('#view-docs [data-tab="vax"]')).includes('to check')) fail('documents tab: vaccinations row lacks what is open');
  await page.click('#view-docs [data-tab="checkups"]');
  if ((await page.locator('.tabs [data-tab="docs"][aria-selected="true"]').count()) !== 1) fail('documents tab: not lit while on Checkups');
  await page.click('#view-checkups .head [data-tab="docs"]');
  await page.click('#view-docs .vx-row[data-card]');
  await page.click('#view-card [data-tab]');
  if (await page.isHidden('#view-docs')) fail('documents tab: Back from the card does not return to Documents');
  // Back returns to the screen the card was opened from
  await page.click('[data-act="close"]').catch(() => {});
  await openTab(page, 'vax');
  await page.click('#view-vax .head .sos');
  await page.click('#view-card [data-tab]');
  if (await page.isHidden('#view-vax')) fail('card: Back does not return to the screen it was opened from');
  // The home-screen shortcut opens the card straight away
  await settle(page); await page.goto(url + '?open=card'); await page.waitForSelector('h1');
  if (await page.isHidden('#view-card')) fail('card: home-screen shortcut does not open the card');
  if (new URL(page.url()).search) fail('card: shortcut address kept, so a reload would reopen the card');
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
    const sys = body.messages[0].content, user = body.messages[1].content;
    // Notes to translate come as {"notes": [...]}; the fake service answers each with a marked copy
    const content = /translate notes/.test(sys) ? JSON.stringify({ translations: JSON.parse(user).notes.map(n => 'DE: ' + n) }) : '[CHILD] is on day 3.';
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ choices: [{ message: { content } }] }) });
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

  // The doctor summary in German: fixed wording, symptom tags and decimal commas on the phone, typed notes by the AI
  await page.click('[data-doclang="de"]');
  const doc = () => page.locator('.doc-lang').textContent();
  for (const w of ['Tag 1', 'Max. Temp.', 'Neue Symptome', 'Ärztliche Hinweise', 'Krankheitsbeginn']) if (!(await doc()).includes(w)) fail(`german: "${w}" missing`);
  if (!/\d,\d°C/.test(await doc())) fail('german: no decimal comma in temperatures');
  if (/Max temp|New symptoms|readings/.test(await doc())) fail('german: English wording left in the summary');
  if (!(await doc()).includes('Husten') && !(await doc()).includes('Fieber')) fail('german: symptom tags not translated');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('german: doctor view scrolls sideways');
  await page.click('[data-act="doc-translate"]');
  await page.waitForSelector('.doc-said >> text=DE:');
  if (!/German/.test(body.messages[0].content) || JSON.stringify(body).includes('Mia')) fail('german: notes not sent for translation without names');
  if ((await page.locator('[data-act="doc-translate"]').count()) !== 0) fail('german: translate button still shown after translating');
  await reload(page);
  { const s = await getState(page); if (s.settings.docLang !== 'de' || !Object.keys(s.docTr?.de || {}).length) fail('german: language or translations not kept'); }
  await page.click('[data-act="open-sick"]');
  await page.click('[data-sick="doctor"]');
  if (!(await doc()).includes('DE:')) fail('german: translations not shown after reopening');
  await page.click('[data-doclang="en"]');
  if (!(await doc()).includes('Day 1') || (await doc()).includes('DE:')) fail('german: switching back to English did not restore the summary');
  await page.close();
}

// Drive sync against a fake Drive: a second phone saving at the same moment, and a damaged Drive file
{
  const page = await newPage();
  page.on('pageerror', e => fail(`sync: ${e.message}`));
  await page.addInitScript(() => { window.google = { accounts: { oauth2: { initTokenClient: o => ({ requestAccessToken: () => o.callback({ access_token: 't', expires_in: 3600 }) }) } } }; });
  const other = (id, t) => ({ id, child: 'kid-ex', type: 'note', t, note: 'From the other phone', updatedAt: t });
  // "future" stands for a part added by a later version of the app without a format change; it must be kept.
  const drive = { file: { app: 'aura', v: 3, children: [], episodes: [], entries: [other('o1', 1000)], meds: [], measurements: [], growth: [], future: ['kept'] }, patches: 0, race: true, uploads: [], queries: [], version: 1, downloads: 0, media: [], saved: {}, resumable: 0, names: { f1: 'aura-log.json', logdir: 'Aura' }, renames: [] };
  const setFile = f => { drive.file = f; drive.version++; }; // a change by someone else bumps Drive's version number
  await page.route('https://www.googleapis.com/**', async route => {
    const req = route.request(), u = new URL(req.url()), m = req.method();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: typeof b === 'string' ? b : JSON.stringify(b) });
    if (u.pathname.startsWith('/upload') && m === 'PATCH' && u.searchParams.get('uploadType') === 'resumable') return route.fulfill({ status: 200, headers: { Location: 'https://www.googleapis.com/upload/session/1', 'Access-Control-Expose-Headers': 'Location' }, body: '' });
    if ((u.pathname.startsWith('/upload') && m === 'PATCH') || (u.pathname === '/upload/session/1' && m === 'PUT')) {
      if (m === 'PUT') drive.resumable++;
      drive.patches++; drive.file = JSON.parse(req.postData()); const mine = String(++drive.version);
      // Another phone overwrites right after us with its own copy, which lacks our entries
      if (drive.race) { drive.race = false; setFile({ ...drive.file, entries: [other('o1', 1000), other('o2', 2000)] }); }
      return json({ version: mine });
    }
    if (u.pathname.startsWith('/upload') && m === 'POST') {
      // multipart: metadata, then the file; a picture or sound is sent as bytes
      const raw = req.postDataBuffer().toString('latin1'), parts = raw.split(/\r\n--aura[^\r\n]*/), meta = JSON.parse(parts[0].split('\r\n\r\n')[1]), body = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n');
      drive.uploads.push(raw); const id = 'b' + drive.uploads.length;
      if (meta.parents[0] === 'media') drive.media.push({ id, name: meta.name, body: Buffer.from(body, 'latin1') }); else drive.saved[id] = body;
      return json({ id });
    }
    if (u.pathname === '/drive/v3/files' && m === 'POST') return json({ id: JSON.parse(req.postData()).name }); // a new folder is named by its id
    const mf = drive.media.find(f => u.pathname === '/drive/v3/files/' + f.id); if (mf) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: mf.body });
    if (drive.saved[u.pathname.split('/').pop()]) return json(drive.saved[u.pathname.split('/').pop()]);
    if (u.pathname === '/drive/v3/files/f1' && u.searchParams.get('alt') === 'media') { drive.downloads++; return json(drive.file); }
    // A log made while the app was called Aura is renamed in place, with its folder
    if (m === 'PATCH' && u.pathname.startsWith('/drive/v3/files/')) { const id = u.pathname.split('/').pop(), b = JSON.parse(req.postData() || '{}'); if (b.name) { drive.renames.push([id, b.name]); drive.names[id] = b.name; } return json({}); }
    if (u.pathname === '/drive/v3/files/logdir') return json({ name: drive.names.logdir });
    if (u.pathname === '/drive/v3/files/f1') return json({ name: drive.names.f1, ownedByMe: true, parents: ['logdir'], version: String(drive.version) });
    if (u.pathname === '/drive/v3/files') drive.queries.push(u.searchParams.get('q') || '');
    if (u.pathname === '/drive/v3/files' && (u.searchParams.get('q') || '').startsWith("'backups' in parents")) return json({ files: drive.saved.bkx ? [{ id: 'bkx', name: 'aura-backup-2026-10-08-09.json' }] : [] });
    if (u.pathname === '/drive/v3/files' && (u.searchParams.get('q') || '').startsWith("'media' in parents")) return json({ files: drive.media.map(({ id, name }) => ({ id, name })) });
    if (u.pathname === '/drive/v3/files') return json({ files: (u.searchParams.get('q') || '').includes('in parents') ? [] : [{ id: 'folder' }] });
    return json({});
  });
  await page.goto(url);
  await page.waitForSelector('h1');
  const st = await getState(page); st.example = false; st.settings.clientId = 'x-y.apps.googleusercontent.com'; st.drive = { fileId: 'f1' };
  st.docs.push({ id: 'd1', childId: 'kid-ex', type: 'other', title: 'Allergy pass', note: '', updatedAt: Date.now() });
  st.pages.push({ id: 'vp1', docId: 'vax-kid-ex', childId: 'kid-ex', t: 1000, img: 'data:image/jpeg;base64,/9j/BOOK', note: '', order: 0, updatedAt: Date.now() });
  st.pages.push({ id: 'dp1', docId: 'd1', childId: 'kid-ex', t: 1000, img: 'data:image/jpeg;base64,/9j/ALLERGY', note: '', order: 0, updatedAt: Date.now() });
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  await page.click('[data-act="sync-tap"]');
  await page.waitForSelector('.sync.ok');
  const mine = (await getState(page)).entries;
  if (!['o1', 'o2'].every(id => mine.some(e => e.id === id))) fail('sync: entry from the other phone not merged');
  if (!mine.every(e => drive.file.entries.some(x => x.id === e.id))) fail('sync: our entries lost after the other phone wrote');
  if (drive.patches !== 2) fail(`sync: expected a second write after the clash, got ${drive.patches}`);
  if (!drive.uploads.some(b => b.includes('allo-auri-backup-'))) fail('sync: no backup saved before overwriting');
  if (drive.names.f1 !== 'allo-auri-log.json' || drive.names.logdir !== 'Allo Auri') fail('sync: old Aura log and folder not renamed: ' + JSON.stringify(drive.names));
  if (!drive.queries.some(q => q.includes("name='backups'") && q.includes("'logdir' in parents"))) fail('sync: backups not kept next to the log (so a moved or renamed folder would lose them)');
  if (!drive.file.vaccines?.some(v => v.kind === 'dose')) fail('sync: vaccinations not written to Drive');
  if (!drive.file.emergency?.some(x => x.childId === 'kid-ex' && x.allergies)) fail('sync: emergency card not written to Drive');
  if (!drive.file.pages?.some(v => v.id === 'vp1' && v.img === 'data:image/jpeg;base64,/9j/BOOK')) fail('sync: page of the vaccination book not written to Drive');
  if (!drive.file.pages?.some(v => v.id === 'dp1' && v.img === 'data:image/jpeg;base64,/9j/ALLERGY') || !drive.file.docs?.some(d => d.id === 'd1' && d.title === 'Allergy pass')) fail('sync: other document not written to Drive');
  if (!drive.file.checkups?.some(v => v.kind === 'exam' && v.u === 'U7')) fail('sync: checkups not written to Drive');
  if (drive.file.future?.[0] !== 'kept') fail('sync: a part of the Drive file this version does not know was dropped');
  // With nothing changed on either side, a sync only asks Drive for the version number and downloads nothing
  let downloads = drive.downloads, patches = drive.patches;
  const syncNow = async () => { await page.evaluate(() => { document.getElementById('toast').hidden = true; }); await page.click('[data-act="sync-tap"]'); await page.waitForSelector('#toast:not([hidden])'); };
  await syncNow();
  if (!(await page.locator('#toast').innerText()).startsWith('Synced')) fail('sync: no feedback after tapping sync');
  if (drive.downloads !== downloads || drive.patches !== patches) fail('sync: an idle sync downloaded or wrote the file');
  if (drive.renames.length !== 2) fail('sync: renamed again after the first sync: ' + JSON.stringify(drive.renames));
  // A change by the other phone is picked up
  setFile({ ...drive.file, entries: [...drive.file.entries, other('o3', 3000)] });
  await syncNow();
  if (!(await getState(page)).entries.some(e => e.id === 'o3')) fail('sync: change from the other phone not picked up');
  // Drive backups hold each photo, page and sound once, as its own file in backups/media, and the backup points to it
  // (the app's code is private, so the test changes the saved log and reloads)
  // Reloads first, so a sync the app still has scheduled (1.5 s after a change) can't save over what the test writes.
  const edit = async f => { await reload(page); await page.waitForSelector('h1'); const x = await getState(page); f(x); x.changedAt = Date.now(); await setState(page, x); await reload(page); await page.waitForSelector('h1'); };
  const backupNow = () => edit(x => { x.drive.backupHour = null; x.entries[0].updatedAt = Date.now(); }); // a change, so the Drive log is written and backed up first
  await backupNow(); await syncNow();
  const bkId = Object.keys(drive.saved).filter(k => drive.saved[k].includes('"vp1"')).pop(), bk = bkId && JSON.parse(drive.saved[bkId]);
  const book = drive.media.find(f => f.body.equals(Buffer.from('/9j/BOOK', 'base64')));
  if (!book || !/^[0-9a-f]{64}\.jpeg$/.test(book.name)) fail('backup: page photo not kept as its own file in backups/media');
  if (!bk || bk.pages.find(p => p.id === 'vp1').img !== `aura-media:${book?.name}#data:image/jpeg;base64`) fail('backup: page photo not referenced from the backup');
  if (drive.saved[bkId]?.includes('/9j/BOOK')) fail('backup: page photo copied into the backup again');
  let mediaN = drive.media.length; await backupNow(); await syncNow();
  if (drive.media.length !== mediaN) fail('backup: a photo already in backups/media was uploaded again');
  // Restoring that backup puts the photo back in; an item whose photo is missing from backups/media is left out
  await edit(x => { x.pages = x.pages.filter(p => p.id !== 'vp1'); });
  drive.saved.bkx = JSON.stringify({ ...bk, pages: [...bk.pages, { id: 'gone', docId: 'd1', childId: 'kid-ex', t: 1, img: 'aura-media:' + 'f'.repeat(64) + '.jpeg#data:image/jpeg;base64', updatedAt: 1 }] });
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await openTab(page, 'more'); await page.click('[data-act="drive-backups"]'); await page.click('[data-backup="bkx"]'); await page.waitForSelector('#toast:not([hidden])');
  const restored = await getState(page);
  if (restored.pages.find(p => p.id === 'vp1')?.img !== 'data:image/jpeg;base64,/9j/BOOK') fail('restore: page photo not put back from backups/media');
  if (restored.pages.some(p => p.id === 'gone')) fail('restore: an item with a missing photo was restored blank');
  { const t = await page.locator('#toast').innerText(); if (!t.includes('1 photo or sound missing')) fail('restore: missing photo not mentioned: ' + t); }
  // A log over 5 MB (many photos) still syncs, as a resumable upload
  await edit(x => { x.pages.push({ id: 'big', docId: 'd1', childId: 'kid-ex', t: 2, order: 1, img: 'data:image/jpeg;base64,' + 'A'.repeat(5e6), note: '', updatedAt: Date.now() }); });
  await openTab(page, 'today'); await syncNow();
  if (!drive.resumable || !drive.file.pages?.some(p => p.id === 'big')) fail('sync: a log over 5 MB was not written to Drive');
  await edit(x => { x.pages = x.pages.filter(p => p.id !== 'big'); });
  drive.file = { ...drive.file, pages: drive.file.pages.filter(p => p.id !== 'big') }; drive.version++;
  // A log saved by a newer version of the app is never overwritten by this one
  setFile({ ...drive.file, v: 99 }); let before = drive.patches;
  await page.click('[data-act="sync-tap"]');
  await page.waitForSelector('.sync.err');
  if (drive.patches !== before || drive.file.v !== 99) fail('sync: a newer log in Drive was overwritten');
  // An older log in Drive is upgraded, after a copy of it as it was is kept as allo-auri-log-before-v3.json
  setFile({ app: 'sick-day-log', v: 1, children: [], episodes: [], entries: [other('old1', 500)], meds: [], measurements: [] }); before = drive.uploads.length;
  await page.click('[data-act="sync-tap"]');
  await page.waitForSelector('.sync.ok');
  if (!drive.uploads.slice(before).some(b => b.includes('allo-auri-log-before-v3.json') && b.includes('sick-day-log'))) fail('sync: no copy kept before upgrading the Drive log');
  if (drive.file.v !== 3 || !drive.file.entries.some(e => e.id === 'old1')) fail('sync: older Drive log not upgraded');
  // A v2 Drive log (written by a phone that is not updated yet) has its book photos moved into pages too
  setFile({ ...drive.file, v: 2, vaccines: [...drive.file.vaccines, { id: 'old-pg', childId: 'kid-ex', kind: 'page', t: 1, img: 'data:image/jpeg;base64,/9j/OLD', note: 'p. 4', updatedAt: 7 }] });
  await page.click('[data-act="sync-tap"]');
  for (let i = 0; i < 50 && drive.file.v !== 3; i++) await page.waitForTimeout(100);
  await page.waitForFunction(() => !document.body.innerText.includes('Syncing…'));
  await page.waitForSelector('.sync.ok');
  if (drive.file.v !== 3 || !drive.file.pages.some(p => p.id === 'old-pg' && p.docId === 'vax-kid-ex' && p.img.endsWith('OLD') && p.note === 'p. 4')) fail('sync: book photo in an older Drive log not moved into pages ');
  if (!drive.file.vaccines.some(v => v.id === 'old-pg' && v.deleted && !v.img)) fail('sync: book photo in an older Drive log left in vaccinations');
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
  if ((await getState(page, 'before-v3'))?.app !== 'sick-day-log') fail('migration: no copy kept of the log before the upgrade');
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

// WHO percentiles: shown once the child's sex is set, with values that match the WHO tables
{
  const page = await newPage();
  page.on('pageerror', e => fail(`percentiles: ${e.message}`));
  await page.goto(url); await page.waitForSelector('h1');
  const st = await getState(page), at12 = Date.parse('2025-01-01') + 12 * 30.4375 * 864e5;
  Object.assign(st, { example: false, child: 'k1', children: [{ id: 'k1', name: 'Ben', dob: '2025-01-01', updatedAt: 1 }], entries: [], episodes: [], growth: [], vaccines: [],
    measurements: [{ id: 'm1', childId: 'k1', t: at12, weightKg: 8.6, heightCm: 75.7488, headCm: 46.1, updatedAt: 1 }, { id: 'm2', childId: 'k1', t: at12 - 90 * 864e5, weightKg: 8.4, heightCm: 72, updatedAt: 1 }] });
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  await page.click('.tabs [data-tab="growth"]');
  if ((await page.locator('svg.curve').count()) !== 0 || (await page.locator('.tile .pct').count()) !== 0) fail('percentiles: shown without sex');
  await page.click('#view-growth [data-kid="k1"]');
  await page.selectOption('#k_sex', 'm');
  await page.click('[data-act="save-kid"]');
  if ((await page.locator('svg.curve').count()) !== 3) fail('percentiles: weight, height and head curves not all shown');
  const tile = async l => page.locator('.tile', { hasText: l }).locator('.pct').innerText();
  if ((await tile('Weight')) !== '15th percentile') fail(`percentiles: weight is ${await tile('Weight')}, WHO says 15th`);
  if ((await tile('Height')) !== '50th percentile') fail(`percentiles: height is ${await tile('Height')}, WHO says 50th`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('percentiles: Growth scrolls sideways');
  await reload(page); await page.waitForSelector('h1');
  if ((await getState(page)).children[0].sex !== 'm') fail('percentiles: sex not saved');
  await page.close();
}

// Documents: the vaccination book and U-Heft are kept page by page; with AI reading on, a page that is added or
// replaced is read, and the entries not recorded yet are proposed (nothing is saved until checked). Any other paper
// document can be kept the same way.
{
  const page = await newPage();
  page.on('pageerror', e => fail(`documents: ${e.message}`));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const red = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const file = (name, buffer = png) => ({ name, mimeType: 'image/png', buffer });
  await page.goto(url);
  await page.waitForSelector('h1');
  // Without an AI service pages are just kept, and the page says how to have them read
  await openTab(page, 'vax');
  await addPage(page, '#view-vax [data-act="doc-add"] >> nth=0', [file('a.png'), file('b.png')]);
  if ((await page.innerText('#sheet h2')) !== 'Page 1 of 2') fail(`documents: new page opens as ${await page.innerText('#sheet h2')}`);
  if ((await page.locator('#sheet [data-act="doc-setup"]').count()) !== 1 || (await page.locator('#scanOk').count()) !== 0) fail('documents: reading offered without an AI service');
  await page.click('#sheet [data-act="close"]');
  if ((await page.locator('#view-vax .book .pg').allInnerTexts()).join() !== '1,2') fail('documents: pages not numbered in order');

  let st = await getState(page);
  const old = st.vaccines.find(v => v.kind === 'dose' && v.against.includes('mmr')), oldDay = new Date(old.t - new Date(old.t).getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  Object.assign(st.settings, { aiKind: 'openai', aiBase: 'https://ai.example.com/v1', aiModel: 'vision-model', apiKey: 'k1' });
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  let body = null, calls = 0;
  await page.route('https://ai.example.com/v1/chat/completions', async route => {
    body = route.request().postDataJSON(); calls++;
    const vax = /vaccination record/.test(body.messages[0].content);
    const content = JSON.stringify(vax ? { doses: [
      { date: oldDay, against: ['mmr', 'var'], name: 'Priorix-Tetra', batch: 'AB1', by: 'Dr. Weber' },
      { date: '2026-01-14', against: ['fsme'], name: 'FSME-Immun Junior', batch: 'K42', by: 'Praxis Sonne' },
      { date: null, against: ['flu'], name: 'Fluenz', batch: null, by: null },
      { date: '2999-01-01', against: ['covid'], name: null, batch: null, by: null }] }
      : { checkups: [{ u: 'U6', date: '2025-08-01', by: null, weightKg: null, heightCm: null, headCm: null }, { u: 'U7a', date: '2026-09-01', by: 'Praxis Sonne', weightKg: 12.5, heightCm: null, headCm: 48 }] });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await openTab(page, 'vax');
  const doses = async () => (await getState(page)).vaccines.filter(v => v.kind === 'dose' && !v.deleted).length, before = await doses();
  // A new page: kept at once, and read only after the parent agrees once
  // Adding a page asks first: camera or photos; Cancel adds nothing
  await page.click('#view-vax [data-act="doc-add"] >> nth=0');
  if (await page.isHidden('#picker')) fail('documents: no choice between camera and photos');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('documents: photo choice scrolls sideways');
  await page.click('[data-pick="no"]');
  if (!(await page.isHidden('#picker')) || !(await page.isHidden('#scrim'))) fail('documents: cancel did not close the photo choice');
  if ((await page.getAttribute('#camFile', 'capture')) !== 'environment') fail('documents: Take a photo does not open the camera');
  await addPage(page, '#view-vax [data-act="doc-add"] >> nth=0', file('c.png'), 'cam');
  if ((await page.innerText('#sheet h2')) !== 'Page 3 of 3') fail('documents: new page not added at the end');
  if (calls) fail('documents: photo sent before agreeing');
  await page.click('[data-act="page-read"]');
  if (calls) fail('documents: photo sent without ticking the box');
  await page.check('#scanOk');
  await page.click('[data-act="page-read"]');
  await page.waitForSelector('#scanOut .scan-item');
  const user = body.messages[1].content;
  if (!Array.isArray(user) || user.filter(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/')).length !== 1) fail('documents: the new page was not the photo sent');
  if (JSON.stringify(body).includes('Mia') || JSON.stringify(body).includes('20' + '24-')) fail('documents: name or birth date sent with the photo');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('documents: page sheet scrolls sideways');
  if ((await page.locator('#scanOut .scan-item').count()) !== 3) fail(`documents: expected 3 new doses to check, got ${await page.locator('#scanOut .scan-item').count()}`);
  if (!(await page.innerText('#scanOut')).includes('Already recorded')) fail('documents: already recorded dose not left out');
  if ((await page.locator('#scanOut [data-si]:checked').count()) !== 1) fail('documents: lines without a readable date are ticked');
  if ((await doses()) !== before) fail('documents: saved before checking');
  await page.check('#scanOut [data-si="1"]');
  await page.click('[data-act="scan-add"]');
  if ((await doses()) !== before) fail('documents: added a dose without a date');
  await page.fill('#scanOut [data-sd="1"]', '2025-11-03');
  await page.click('[data-act="scan-add"]');
  await page.waitForFunction(() => !document.querySelector('#scanOut .scan-item'));
  st = await getState(page);
  const tbe = st.vaccines.find(v => v.batch === 'K42'), flu = st.vaccines.find(v => v.name === 'Fluenz');
  if (!tbe || tbe.against.join() !== 'fsme' || tbe.by !== 'Praxis Sonne' || !tbe.updatedAt) fail('documents: read dose not saved');
  if (!flu || new Date(flu.t).getDate() !== 3) fail('documents: corrected date not used');
  if ((await doses()) !== before + 2) fail(`documents: expected 2 doses added, got ${(await doses()) - before}`);
  if (!st.settings.scanOk) fail('documents: agreement not remembered');
  // Replacing a page reads it again by itself, now that the parent agreed
  calls = 0;
  await choosePhoto(page, '[data-act="page-replace"]', file('newer.png', red));
  await page.waitForSelector('#scanOut .parsed');
  if (calls !== 1) fail('documents: replaced page not read');
  const again = await page.innerText('#scanOut');
  if ((await page.locator('#scanOut .scan-item').count()) !== 2 || again.includes('FSME-Immun') && !again.includes('Already recorded') || !/Already recorded.*TBE/s.test(again)) fail('documents: entries added from the first reading proposed again');
  st = await getState(page);
  if (st.pages.filter(p => p.docId === 'vax-' + st.child && !p.deleted).length !== 3) fail('documents: replacing added a page instead of replacing it');

  // The U-Heft: a recorded checkup is left out, a new one with its measurements is added
  await page.click('#sheet [data-act="close"]');
  await openTab(page, 'checkups');
  await addPage(page, '#view-checkups [data-act="doc-add"] >> nth=0', file('u.png'));
  await page.waitForSelector('#scanOut .scan-item');
  if (!/U-Heft/.test(body.messages[0].content)) fail('documents: U-Heft prompt not used');
  if ((await page.locator('#scanOut .scan-item').count()) !== 1 || !(await page.innerText('#scanOut')).includes('U6')) fail('documents: recorded U6 not left out');
  await page.click('[data-act="scan-add"]');
  await page.click('#sheet [data-act="close"]');
  if ((await page.locator('[data-uitem="U7a"].done').count()) !== 1) fail('documents: read U7a not shown as done');
  st = await getState(page);
  const ex = st.checkups.find(x => x.u === 'U7a' && !x.deleted), m = ex && st.measurements.find(x => x.id === ex.measId);
  if (!ex || ex.by !== 'Praxis Sonne') fail('documents: checkup not saved');
  if (!m || m.weightKg !== 12.5 || m.headCm !== 48 || m.heightCm != null) fail('documents: checkup measurements not saved for Growth');

  // Reading turned off: a new page is only kept
  calls = 0;
  await page.click('#view-checkups .book [data-pg] >> nth=0');
  await page.uncheck('#scanRead');
  await page.click('#sheet [data-act="close"]');
  await addPage(page, '#view-checkups [data-act="doc-add"] >> nth=0', file('u2.png'));
  await page.waitForTimeout(300);
  if (calls) fail('documents: page read with reading off');
  if ((await getState(page)).settings.scanRead !== false) fail('documents: reading off not remembered');

  // Turning pages, moving one, and deleting one
  await page.click('#sheet [aria-label="Previous page"]');
  if ((await page.innerText('#sheet h2')) !== 'Page 1 of 2') fail('documents: previous page does not turn');
  const firstId = (await getState(page)).pages.find(p => p.docId.startsWith('u-') && p.order === 0)?.id;
  await page.fill('#pg_note', 'U7a');
  await page.click('[data-act="page-move"][data-for="1"]');
  if ((await page.innerText('#sheet h2')) !== 'Page 2 of 2') fail('documents: moved page not second');
  st = await getState(page);
  const moved = st.pages.find(p => p.id === firstId);
  if (!moved || moved.note !== 'U7a' || moved.order !== 1) fail('documents: moved page or its note not saved');
  await page.click('[data-act="page-del"]');
  if ((await page.innerText('#sheet h2')) !== 'Page 1 of 1') fail('documents: delete does not move to the remaining page');
  await page.click('#sheet [data-act="close"]');
  if ((await page.locator('#view-checkups .book [data-pg]').count()) !== 1) fail('documents: deleted page still shown');
  // A note for the whole U-Heft, from its card; a page with a note is marked in the grid
  await page.click('#view-checkups [data-act="doc-note"]');
  await page.fill('#doc_note', 'Kept in the blue folder');
  await page.click('#sheet [data-act="doc-save"]');
  if ((await getState(page)).docs.find(d => d.id.startsWith('u-'))?.note !== 'Kept in the blue folder' || !(await page.innerText('#view-checkups')).includes('Kept in the blue folder')) fail('documents: note on the whole U-Heft not saved or shown');
  await page.click('#view-checkups .book [data-pg]');
  await page.fill('#pg_note', 'U8 page'); await page.click('#sheet h2');
  await page.click('#sheet [data-act="close"]');
  if ((await page.locator('#view-checkups .book .pg.nt').count()) !== 1) fail('documents: page with a note not marked');

  // Any other document: name it, add pages, find it under Documents, delete it only after a second tap
  await page.click('.tabs [data-tab="docs"]');
  await page.click('[data-act="doc-new"]');
  await page.fill('#doc_title', 'Allergy pass');
  await page.fill('#doc_note', 'From the clinic');
  await choosePhoto(page, '[data-act="doc-save"]', [file('x.png'), file('y.png')]);
  await page.waitForSelector('#pageImg');
  if ((await page.locator('#scanOk, #scanRead, [data-act="page-read"]').count()) !== 0) fail('documents: reading offered for a document without a reader');
  await page.click('#sheet [data-act="close"]');
  const row = page.locator('#view-docs [data-docid]', { hasText: 'Allergy pass' });
  if ((await row.count()) !== 1 || !(await row.innerText()).includes('2 pages') || !(await row.innerText()).includes('From the clinic')) fail('documents: other document not listed with its pages');
  if (!(await page.innerText('#view-docs [data-tab="vax"]')).includes('page')) fail('documents: vaccination book pages not counted under Documents');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('documents: Documents tab scrolls sideways');
  await row.click();
  await page.click('[data-act="doc-del"]');
  if (await page.isHidden('#scrim')) fail('documents: deleted without a second tap');
  await page.click('[data-act="doc-del"]');
  st = await getState(page);
  const ap = st.docs.find(d => d.title === 'Allergy pass');
  if (!ap?.deleted || st.pages.some(p => p.docId === ap.id && !p.deleted)) fail('documents: deleted document or its pages still kept');
  await page.close();
}

// Kita papers: added from their own card with a kind, measles doses shown next to the proof, other documents can move in
{
  const page = await newPage();
  page.on('pageerror', e => fail(`kita: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  { const st = await getState(page); st.docs.push({ id: 'd2', childId: st.child, type: 'other', title: 'Daycare contract', note: '', updatedAt: Date.now() }); await setState(page, st); }
  await reload(page); await page.waitForSelector('h1');
  await page.click('.tabs [data-tab="docs"]');
  const s0 = await getState(page), mmr = s0.vaccines.filter(v => v.kind === 'dose' && !v.deleted && v.childId === s0.child && v.against?.includes('mmr')).length;
  if (!(await page.innerText('#kitaCard')).includes(mmr ? `Measles doses recorded in Auri: ${mmr}` : 'No measles dose')) fail('kita: measles doses not shown');
  await page.click('#kitaCard [data-act="doc-new"]');
  if ((await page.inputValue('#doc_title')) !== 'Kita contract') fail('kita: name not filled in from the kind');
  await page.click('#sheet [data-kitakind="measles"]');
  if ((await page.inputValue('#doc_title')) !== 'Measles proof') fail('kita: name does not follow the kind');
  await addPage(page, '#sheet [data-act="doc-save"]', { name: 'page.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.click('#sheet [data-act="close"]');
  let st = await getState(page);
  const m = st.docs.find(d => d.kita === 'measles');
  if (!m || m.type !== 'other' || m.title !== 'Measles proof' || !st.pages.some(p => p.docId === m.id && !p.deleted)) fail('kita: measles proof not saved with its page');
  // A document added before moves into the Kita card
  await page.click('#view-docs [data-docid="d2"]');
  await page.click('#sheet [data-kitakind="contract"]');
  if ((await page.inputValue('#doc_title')) !== 'Daycare contract') fail('kita: kind overwrote a name the parent typed');
  await page.click('#sheet [data-act="doc-save"]');
  st = await getState(page);
  if (st.docs.find(d => d.id === 'd2')?.kita !== 'contract') fail('kita: kind not saved on an existing document');
  const kc = await page.innerText('#kitaCard');
  if (!kc.includes('Daycare contract') || !kc.includes('Measles proof') || kc.indexOf('Daycare contract') > kc.indexOf('Measles proof')) fail('kita: card does not list the papers in order');
  if ((await page.locator('#view-docs .card:not(#kitaCard) [data-docid="d2"]').count()) !== 0) fail('kita: paper still under other documents');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail('kita: Documents scrolls sideways');
  // Taken out of the Kita again
  await page.click('#kitaCard [data-docid="d2"]');
  await page.click('#sheet [data-kitakind=""]');
  await page.click('#sheet [data-act="doc-save"]');
  if ((await getState(page)).docs.find(d => d.id === 'd2')?.kita) fail('kita: could not take a paper out of the Kita');
  // From the measles proof to the vaccinations
  await page.click(`#kitaCard [data-docid="${m.id}"]`);
  await page.click('#sheet [data-tab="vax"]');
  if (await page.isHidden('#view-vax') || !(await page.isHidden('#scrim'))) fail('kita: measles proof does not lead to the vaccinations');
  await page.close();
}

// Documents as PDF: saved from a document, and kept in Drive's documents folder, made again only when the pages change
{
  const page = await newPage();
  page.on('pageerror', e => fail(`pdf: ${e.message}`));
  await page.addInitScript(() => { window.google = { accounts: { oauth2: { initTokenClient: o => ({ requestAccessToken: () => o.callback({ access_token: 't', expires_in: 3600 }) }) } } }; });
  const drive = { file: null, version: 1, pdfs: [], patched: [], trashed: [] };
  await page.route('https://www.googleapis.com/**', async route => {
    const req = route.request(), u = new URL(req.url()), m = req.method(), id = u.pathname.split('/').pop();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.pathname.startsWith('/upload') && m === 'PATCH' && id === 'f1') { drive.file = JSON.parse(req.postData()); return json({ version: String(++drive.version) }); }
    if (u.pathname.startsWith('/upload') && m === 'PATCH') { drive.patched.push({ id, type: req.headers()['content-type'], body: req.postDataBuffer() }); return json({}); }
    if (u.pathname.startsWith('/upload') && m === 'POST') {
      const raw = req.postDataBuffer().toString('latin1'), meta = JSON.parse(raw.split('\r\n\r\n')[1].split('\r\n')[0]);
      if (meta.name.endsWith('.pdf')) { drive.pdfs.push({ ...meta, body: raw }); return json({ id: 'pdf' + drive.pdfs.length }); }
      return json({ id: 'up' + Math.random() });
    }
    if (u.pathname === '/drive/v3/files' && m === 'POST') return json({ id: JSON.parse(req.postData()).name });
    if (/^\/drive\/v3\/files\/pdf/.test(u.pathname) && m === 'PATCH') { const b = JSON.parse(req.postData()); if (b.trashed) drive.trashed.push(id); return json({}); }
    if (id === 'f1' && u.searchParams.get('alt') === 'media') return json(drive.file);
    if (id === 'f1') return json({ ownedByMe: true, parents: ['logdir'], version: String(drive.version) });
    if (u.pathname === '/drive/v3/files') return json({ files: [] });
    return json({});
  });
  await page.goto(url);
  await page.waitForSelector('h1');
  const jpg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 60; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 40, 60); return c.toDataURL('image/jpeg', 0.8); });
  const st = await getState(page); st.example = false; st.settings.clientId = 'x-y.apps.googleusercontent.com'; st.drive = { fileId: 'f1' };
  drive.file = { app: 'aura', v: st.v, entries: [] };
  st.docs.push({ id: 'k1', childId: st.child, type: 'other', kita: 'contract', title: 'Kita contract', note: '', updatedAt: Date.now() });
  st.pages.push({ id: 'kp1', docId: 'k1', childId: st.child, t: 1, img: jpg, note: '', order: 0, updatedAt: Date.now() }, { id: 'kp2', docId: 'k1', childId: st.child, t: 2, img: jpg, note: '', order: 1, updatedAt: Date.now() });
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  // Saved from the document's sheet
  await page.click('.tabs [data-tab="docs"]');
  await page.click('#kitaCard [data-docid="k1"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sheet [data-act="doc-pdf"]')]);
  const pdf = readFileSync(await dl.path()).toString('latin1');
  if (!pdf.startsWith('%PDF-1.4') || !pdf.includes('/Count 2') || (pdf.match(/\/DCTDecode/g) || []).length !== 2 || !pdf.trimEnd().endsWith('%%EOF')) fail('pdf: saved PDF is not the two pages');
  const xref = +pdf.match(/startxref\n(\d+)/)[1]; if (pdf.slice(xref, xref + 4) !== 'xref') fail('pdf: cross-reference table offset wrong');
  if (!dl.suggestedFilename().startsWith('Kita contract - ')) fail('pdf: file name lacks the document name');
  await page.click('#sheet [data-act="close"]');
  // Drive: one PDF per document, in a documents folder next to the log
  const syncNow = async () => { await page.evaluate(() => { document.getElementById('toast').hidden = true; }); await page.click('[data-act="sync-tap"]:visible'); await page.waitForSelector('#toast:not([hidden])'); };
  const settled = () => page.waitForTimeout(1000); // PDFs go up after the sync has finished
  const edit = async f => { await reload(page); await page.waitForSelector('h1'); const x = await getState(page); f(x); x.changedAt = Date.now(); await setState(page, x); await reload(page); await page.waitForSelector('h1'); };
  await syncNow(); await settled();
  const up = drive.pdfs.filter(f => f.name.startsWith('Kita contract'));
  if (up.length !== 1 || up[0].parents[0] !== 'documents' || !up[0].body.includes('/Count 2')) fail('pdf: document not kept as a PDF in Drive');
  const n = drive.pdfs.length;
  await edit(x => { const e = x.entries.find(y => !y.deleted); e.note = 'changed'; e.updatedAt = Date.now(); });
  await syncNow(); await settled();
  if (drive.pdfs.length !== n || drive.patched.length) fail('pdf: an unchanged document was made again');
  // A replaced page updates the same PDF; a deleted document's PDF goes to the trash
  await edit(x => { const p = x.pages.find(y => y.id === 'kp2'); p.order = 0; p.updatedAt = Date.now(); x.pages.find(y => y.id === 'kp1').order = 1; });
  await syncNow(); await settled();
  const pid = up[0] && 'pdf' + (drive.pdfs.indexOf(up[0]) + 1);
  if (!drive.patched.some(x => x.id === pid && x.type === 'application/pdf')) fail('pdf: changed document not updated in Drive');
  await edit(x => { const d = x.docs.find(y => y.id === 'k1'); d.deleted = true; d.updatedAt = Date.now(); });
  await syncNow(); await settled();
  if (!drive.trashed.includes(pid)) fail('pdf: deleted document still kept as a PDF');
  await page.close();
}

// Upgrade from v2: photos of the book inside vaccinations and checkups become pages of documents, and the log as it was is kept
{
  const page = await newPage();
  page.on('pageerror', e => fail(`upgrade v3: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('h1');
  const st = await getState(page);
  Object.assign(st, { v: 2, example: false, docs: undefined, pages: undefined });
  st.vaccines.push({ id: 'p1', childId: st.child, kind: 'page', t: 2000, img: 'data:image/jpeg;base64,/9j/P1', note: 'pages 4 and 5', updatedAt: 10 },
    { id: 'p0', childId: st.child, kind: 'page', t: 1000, img: 'data:image/jpeg;base64,/9j/P0', note: '', updatedAt: 9 },
    { id: 'p9', childId: st.child, kind: 'page', deleted: true, t: 1, updatedAt: 3 });
  st.checkups.push({ id: 'q1', childId: st.child, kind: 'page', t: 3000, img: 'data:image/jpeg;base64,/9j/Q1', note: '', order: 0, updatedAt: 11 });
  delete st.docs; delete st.pages;
  await setState(page, st); await reload(page); await page.waitForSelector('h1');
  const up = await getState(page), kept = await getState(page, 'before-v3');
  if (up.v !== 3) fail('upgrade v3: log not upgraded');
  if (kept?.v !== 2 || !kept.vaccines.some(v => v.id === 'p1' && v.img.endsWith('P1'))) fail('upgrade v3: no copy kept of the log before the upgrade');
  const vb = up.pages.filter(p => p.docId === 'vax-' + st.child);
  if (vb.length !== 2 || !vb.some(p => p.id === 'p1' && p.img.endsWith('P1') && p.note === 'pages 4 and 5' && p.updatedAt === 10)) fail('upgrade v3: book photos not moved into pages');
  if (up.pages.some(p => p.id === 'p9')) fail('upgrade v3: a deleted photo came back');
  if (!up.pages.some(p => p.id === 'q1' && p.docId === 'u-' + st.child && p.order === 0)) fail('upgrade v3: U-Heft photo not moved into pages');
  if (!up.vaccines.filter(v => v.kind === 'page').every(v => v.deleted && !v.img) || !up.checkups.filter(v => v.kind === 'page').every(v => v.deleted && !v.img)) fail('upgrade v3: old photo records not cleared');
  if (!up.docs.some(d => d.id === 'vax-' + st.child && d.type === 'vax') || !up.docs.some(d => d.id === 'u-' + st.child && d.type === 'u')) fail('upgrade v3: documents not made');
  if (up.vaccines.filter(v => v.kind === 'dose').length !== st.vaccines.filter(v => v.kind === 'dose').length) fail('upgrade v3: vaccinations changed');
  await openTab(page, 'vax');
  if ((await page.locator('#view-vax .book [data-pg]').count()) !== 2) fail('upgrade v3: moved pages not shown');
  await page.click('#view-vax .book [data-pg] >> nth=0');
  if ((await page.getAttribute('#pageImg', 'src')) !== 'data:image/jpeg;base64,/9j/P0') fail('upgrade v3: pages not in the order they were added');
  await page.close();
}

// Dictation: Chrome on Android lists each step of a phrase as its own result; the box must get the words once.
{
  const page = await newPage();
  page.on('pageerror', e => fail(`dictation: ${e.message}`));
  await page.addInitScript(() => { window.SpeechRecognition = class { start() { window.__sr = this; } stop() { this.onend?.(); } }; });
  await page.goto(url); await page.waitForSelector('h1');
  await page.click('[data-add="solids"]');
  await page.click('[data-mic="f_note"]');
  const say = list => page.evaluate(l => { const results = l.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })); window.__sr.onresult({ resultIndex: results.length - 1, results }); }, list);
  await say([['this', true], ['this is', true], ['this is a', false]]);
  await say([['this', true], ['this is', true], ['this is a', true], ['this is a test', true], ["I'm", true], ["I'm testing", true], ["I'm testing this", true]]);
  if ((await page.inputValue('#f_note')) !== "this is a test I'm testing this") fail(`dictation: Android results repeated: ${await page.inputValue('#f_note')}`);
  await page.click('[data-mic="f_note"]');
  await page.fill('#f_note', 'Fed well.');
  await page.click('[data-mic="f_note"]');
  await say([[' slept', true], [' after lunch', false]]);
  if ((await page.inputValue('#f_note')) !== 'Fed well. slept after lunch') fail(`dictation: desktop results wrong: ${await page.inputValue('#f_note')}`);
  await page.close();
}

// Opening the app asks no other site for anything (fonts and the AI library are served with the app); only the recall list is fetched
{
  const page = await newPage(), outside = [];
  page.on('request', r => { const u = r.url(); if (!/^(file|data|blob):/.test(u) && !u.endsWith('/processed.json')) outside.push(u); });
  await page.goto(url); await page.waitForSelector('h1'); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300);
  if (outside.length) fail('privacy: opening the app contacted ' + outside.join(', '));
  const fonts = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/['"]/g, '')));
  if (!fonts.includes('Nunito') || !fonts.includes('Lora')) fail('fonts: Nunito and Lora not loaded from the app: ' + fonts.join(', '));
  await page.close();
}

await browser.close();
if (errors.length) { console.error('Smoke test failed:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log('Smoke test passed');
