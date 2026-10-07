// Opens the built app at phone width and checks the main screens render without errors or sideways scrolling.
import { chromium } from 'playwright';

const url = new URL('../app/index.html', import.meta.url).href;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
const fail = m => { errors.push(m); };

for (const theme of ['night', 'day']) {
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  page.on('pageerror', e => fail(`${theme}: ${e.message}`));
  await page.goto(url);
  await page.evaluate(t => { const s = JSON.parse(localStorage.getItem('aura.v2')); s.settings.theme = t; localStorage.setItem('aura.v2', JSON.stringify(s)); }, theme);
  await page.reload();
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
    await page.reload();
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
    await page.reload();
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
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('aura.v2')).entries.filter(e => e.type === 'symptom').sort((a, b) => b.updatedAt - a.updatedAt)[0]);
    if (!saved.symptoms.includes('Ear pain')) fail('tag not kept for the doctor summary');
  }

  // Sick view tabs, Growth and More
  await page.click('[data-act="open-sick"]');
  for (const t of ['overview', 'chart', 'doctor']) { await page.click(`[data-sick="${t}"]`); if (await overflow()) fail(`${theme}: sick ${t} scrolls sideways`); }
  for (const t of ['growth', 'more']) { await page.click(`.tabs [data-tab="${t}"]`); if (await overflow()) fail(`${theme}: ${t} scrolls sideways`); }
  // Ending sick mode asks first, then Today returns to everyday tracking
  if (theme === 'day') {
    await page.click('.tabs [data-tab="today"]');
    await page.click('[data-act="end-ask"]');
    await page.click('[data-act="end-episode"]');
    if ((await page.locator('.sick, .sick-card, [data-view]').count()) !== 0) fail('sick mode still shown after ending it');
    if ((await page.locator('[data-act="new-episode"]').count()) !== 1) fail('no way to start sick mode again');
  }
  await page.close();
}

// Data from the earlier Sick Day Log is migrated
{
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  page.on('pageerror', e => fail(`migration: ${e.message}`));
  await page.goto(url);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sickdaylog.v1', JSON.stringify({ app: 'sick-day-log', v: 1, example: false,
    children: [{ id: 'c1', name: 'Leo', dob: '2025-01-01' }], episodes: [{ id: 'e1', childId: 'c1', start: Date.now() - 864e5, end: null }],
    entries: [{ id: 'x1', ep: 'e1', type: 'temp', t: Date.now() - 36e5, tempC: 38.8 }], meds: [], measurements: [], settings: { unit: 'C' } })); });
  await page.reload();
  if (!(await page.locator('h1').first().innerText()).includes('Leo')) fail('migration: child not carried over');
  if ((await page.locator('.sick-card').count()) !== 1) fail('migration: open illness not shown as sick mode');
  await page.close();
}

await browser.close();
if (errors.length) { console.error('Smoke test failed:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log('Smoke test passed');
