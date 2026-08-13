/* Real-browser test for the studio.
 *
 * Runs actual Chromium, because the bugs that bit v1 were all invisible to
 * jsdom: [hidden] defeated by a class that sets display (jsdom reports
 * el.hidden === true and passes while the browser shows the element), and
 * flex panels squashed below their content height so they overlap the panel
 * beneath and steal its clicks. Both are geometry, and jsdom has no layout.
 *
 *   node tests/uitest.mjs [baseUrl]
 */

import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://localhost:8090';
const pass = [], fail = [];

const check = (name, cond, detail = '') => {
  (cond ? pass : fail).push(name);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  -- ' + detail}`);
  return cond;
};

const browser = await chromium.launch({
  executablePath: '/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => failedRequests.push(r.url() + ' ' + r.failure()?.errorText));

try {
  // ---------------------------------------------------------------- load --
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  check('studio loads', await page.title() === 'Glitchsheet');
  check('ES modules ran without error', consoleErrors.length === 0,
    consoleErrors.join(' | '));
  check('no request failed', failedRequests.length === 0, failedRequests.join(' | '));

  await page.waitForFunction(() => +document.querySelector('#opcount').textContent > 0,
    null, { timeout: 15000 });
  const opCount = +await page.textContent('#opcount');
  check('op library is populated from the engine', opCount >= 40, opCount);
  check('library shows categories',
    (await page.locator('.libcat').count()) >= 5,
    await page.locator('.libcat').count());
  check('starters are offered', (await page.locator('#starters button').count()) === 8);

  // The empty state must actually be visible before anything is built.
  check('empty state is showing', await page.locator('#empty').isVisible());
  check('viewer is hidden before any render', !(await page.locator('#view').isVisible()));

  // ------------------------------------------------------------- a chain --
  await page.locator('#starters button', { hasText: 'Cell print' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('#chain .node').length > 0, null, { timeout: 5000 });
  const nodes = await page.locator('#chain .node').count();
  check('starter builds a chain', nodes === 4, nodes);

  // Wait for the render to land -- this is a real evaluation on the backend.
  await page.waitForSelector('#view:not([hidden])', { timeout: 180000 });
  await page.waitForFunction(() => {
    const i = document.querySelector('#view');
    return i && i.complete && i.naturalWidth > 0;
  }, null, { timeout: 60000 });
  check('the artwork renders', await page.locator('#view').isVisible());
  const dims = await page.locator('#view').evaluate(
    (i) => [i.naturalWidth, i.naturalHeight]);
  check('the artwork has real pixels', dims[0] > 50 && dims[1] > 50, dims.join('x'));

  // [hidden] must genuinely hide. This is the trap that jsdom passes and a
  // browser fails: a class that sets `display` outranks [hidden].
  check('empty state is hidden once artwork exists',
    !(await page.locator('#empty').isVisible()));

  await page.waitForFunction(
    () => document.querySelectorAll('#chain .node img.nt').length >= 3,
    null, { timeout: 60000 });
  const thumbs = await page.locator('#chain .node img.nt').count();
  check('chain nodes get their own thumbnails', thumbs >= 3, thumbs);
  const thumbOk = await page.locator('#chain .node img.nt').first()
    .evaluate((i) => i.complete && i.naturalWidth > 0);
  check('node thumbnails actually load', thumbOk);

  // ---------------------------------------------------------- inspector ---
  await page.locator('#chain .node').nth(2).click();
  await page.waitForTimeout(400);
  check('selecting a node fills the inspector',
    (await page.locator('#inspector label, #inspector select').count()) > 0);
  check('inspector explains the op',
    (await page.locator('#inspector .blurb').textContent()).length > 10);
  const selCount = await page.locator('#chain .node[data-sel=true]').count();
  check('exactly one node reads as selected', selCount === 1, selCount);

  // change a parameter and confirm the picture is re-evaluated
  const before = await page.locator('#view').getAttribute('src');
  const shapeSel = page.locator('#inspector select').first();
  await shapeSel.selectOption({ index: 3 });
  await page.waitForFunction(
    (b) => document.querySelector('#view').getAttribute('src') !== b,
    before, { timeout: 120000 });
  check('changing a parameter re-renders', true);

  // ----------------------------------------------------------- variants ---
  await page.selectOption('#vparam', { index: 0 });
  await page.locator('#sweep').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#vgrid .vcard img').length >= 2,
    null, { timeout: 240000 });
  const vcards = await page.locator('#vgrid .vcard img').count();
  check('a sweep returns variants', vcards >= 2, vcards);
  // The element existing is not the same as the image having decoded, and
  // asserting the instant the grid appears is a race the test loses.
  let vimg = false;
  try {
    await page.waitForFunction(() => {
      const i = document.querySelector('#vgrid .vcard img');
      return i && i.complete && i.naturalWidth > 0;
    }, null, { timeout: 30000 });
    vimg = true;
  } catch { /* reported below */ }
  check('variant thumbnails load', vimg);

  // ---------------------------------------------------------- tray/sheet --
  await page.locator('#keep').click();
  await page.waitForFunction(
    () => +document.querySelector('#traycount').textContent > 0,
    null, { timeout: 120000 });
  check('keep puts a design in the tray',
    +await page.textContent('#traycount') === 1);
  check('sheet export unlocks once something is kept',
    !(await page.locator('#ex-sheet').isDisabled()));

  // Build the sheet and confirm it is really a cutsheet/1 document.
  const sheet = await page.evaluate(async () => {
    const start = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'sheet',
        items: window.__gs.proj.tray,
        machine: 'generic', dpi: 300,
      }),
    }).then((r) => r.json());
    for (let i = 0; i < 200; i++) {
      const j = await fetch('/api/job/' + start.job).then((r) => r.json());
      if (j.state === 'done') {
        const doc = await fetch(j.result.url).then((r) => r.json());
        return { format: doc.format, items: doc.doc.items.length,
                 cut: doc.doc.items[0].cut, images: doc.images.length };
      }
      if (j.state === 'error') return { error: j.error };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { error: 'timed out' };
  });
  check('sheet builds through the API', sheet.format === 'cutsheet/1',
    JSON.stringify(sheet).slice(0, 200));
  check('sheet carries the artwork', sheet.images === 1, sheet.images);
  check('a matted sticker cuts on its contour at offset 0',
    sheet.cut && sheet.cut.mode === 'contour' && sheet.cut.offset === 0,
    JSON.stringify(sheet.cut));

  // ------------------------------------------------------------- layout ---
  // v1's "items move everywhere" report was flex panels overlapping. Measure
  // it rather than trusting a screenshot: small text in a narrow rail vanishes
  // under downscaling and I twice "saw" clipping that measurement disproved.
  const overlaps = await page.evaluate(() => {
    const bad = [];
    for (const rail of document.querySelectorAll('.rail')) {
      const panels = [...rail.querySelectorAll(':scope > .panel')];
      for (let i = 1; i < panels.length; i++) {
        const a = panels[i - 1].getBoundingClientRect();
        const b = panels[i].getBoundingClientRect();
        if (b.top < a.bottom - 1) bad.push(`${i - 1}/${i} in .${rail.className}`);
      }
    }
    return bad;
  });
  check('no panel overlaps the one below it', overlaps.length === 0, overlaps.join(', '));

  const squashed = await page.evaluate(() =>
    [...document.querySelectorAll('.rail > .panel')]
      .filter((p) => p.getBoundingClientRect().height < p.scrollHeight - 2).length);
  check('no panel is squashed below its content', squashed === 0, squashed);

  const hscroll = await page.evaluate(
    () => document.body.scrollWidth - document.body.clientWidth);
  check('the page does not scroll sideways', hscroll <= 1, hscroll);

  const offscreen = await page.evaluate(() => {
    const w = window.innerWidth;
    return [...document.querySelectorAll('button, select, input')]
      .filter((e) => e.offsetParent !== null)
      .filter((e) => { const r = e.getBoundingClientRect();
                       return r.right > w + 1 || r.left < -1; }).length;
  });
  check('no control sits outside the viewport', offscreen === 0, offscreen);

  // Nothing that changes size may move the artwork: the stage is absolutely
  // centred, so opening a sweep or adding a node must not shift it.
  const stageBefore = await page.locator('#stage').boundingBox();
  await page.locator('#library button', { hasText: 'Levels' }).first().click();
  await page.waitForTimeout(600);
  const stageAfter = await page.locator('#stage').boundingBox();
  check('adding a node does not move the artwork',
    Math.abs(stageBefore.x - stageAfter.x) < 2 &&
    Math.abs(stageBefore.y - stageAfter.y) < 2,
    `${JSON.stringify(stageBefore)} -> ${JSON.stringify(stageAfter)}`);

  const chainH = await page.locator('#chain').evaluate((e) => e.getBoundingClientRect().height);
  check('the chain strip has a fixed height', Math.abs(chainH - 104) < 2, chainH);

  // ------------------------------------------------------------- narrow ---
  // v1 had no breakpoint and simply broke below ~1100px.
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(400);
  const narrowScroll = await page.evaluate(
    () => document.body.scrollWidth - document.body.clientWidth);
  check('narrow viewport does not scroll sideways', narrowScroll <= 1, narrowScroll);
  check('artwork survives a narrow viewport', await page.locator('#view').isVisible());
  check('panel switcher appears when narrow',
    await page.locator('#panes').isVisible());
  await page.locator('#panes').click();
  await page.waitForTimeout(250);
  check('the panel switcher opens a rail',
    await page.locator('#rail-left').isVisible());

  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/glitchsheet-v2.png' });
  check('no console errors during the whole session',
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('test run completed', false, e.message);
  await page.screenshot({ path: '/tmp/glitchsheet-v2-fail.png' }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log('failed:');
  for (const f of fail) console.log('  - ' + f);
}
process.exit(fail.length ? 1 : 0);
