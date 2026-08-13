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

  // ------------------------------------------------------------- layers ---
  // The stack is a second graph on top of the chain, and the trap it brings is
  // that `S.proj.chain` is now an accessor onto whichever layer is active. If
  // that binding is wrong the studio looks fine and edits the wrong layer, so
  // every check here is about which chain the UI is actually pointing at.
  check('the stack starts with one layer',
    (await page.locator('#stack .lyr').count()) === 1,
    await page.locator('#stack .lyr').count());
  const baseNodes = await page.locator('#chain .node').count();

  await page.locator('#addlayer').click();
  await page.waitForFunction(() => window.__gs.proj.layers.length === 2,
    null, { timeout: 5000 });
  check('adding a layer adds a row',
    (await page.locator('#stack .lyr').count()) === 2);
  check('a new layer becomes the active one',
    await page.evaluate(() => window.__gs.active) === 1);
  check('a new layer starts with an empty chain',
    (await page.locator('#chain .node').count()) === 0,
    await page.locator('#chain .node').count());
  check('the top of the stack is drawn first',
    +await page.locator('#stack .lyr').first().getAttribute('data-i') === 1);

  // Fill it with one cheap source rather than a starter: this test already
  // waits on real ffglitch renders and a second codec chain doubles the run.
  await page.fill('#opsearch', 'truchet');
  await page.waitForTimeout(200);
  await page.locator('#library button').first().click();
  await page.waitForFunction(
    () => window.__gs.proj.layers[1].chain.length === 1, null, { timeout: 5000 });
  // Put the library back: the filter persists, and a later section that looks
  // for an op by name fails 30s later somewhere else entirely.
  await page.fill('#opsearch', '');
  check('an op lands in the ACTIVE layer, not the first one',
    await page.evaluate(() => window.__gs.proj.layers[0].chain.length) === baseNodes,
    await page.evaluate(() => window.__gs.proj.layers.map((l) => l.chain.length).join('/')));

  await page.waitForFunction(() => window.__gs.composite === true,
    null, { timeout: 240000 });
  check('two layers render as a composite', true);
  check('the composite is not any single layer\'s output', await page.evaluate(
    () => !Object.values(window.__gs.layerOut).includes(window.__gs.shownHash)));
  check('the artwork says it is a composite',
    (await page.locator('#osd .chip').first().textContent()).includes('composite'),
    await page.locator('#osd .chip').first().textContent());
  await page.waitForFunction(
    () => [...document.querySelectorAll('#stack img.lt')]
      .every((i) => i.complete && i.naturalWidth > 0)
      && document.querySelectorAll('#stack img.lt').length === 2,
    null, { timeout: 60000 }).catch(() => {});
  check('each layer gets its own thumbnail',
    (await page.locator('#stack img.lt').count()) === 2,
    await page.locator('#stack img.lt').count());

  // The compositing controls are generated from /api/ops, like everything else.
  const lbox = page.locator('#layerbox .lbox');
  check('the layer box is in the inspector', (await lbox.count()) === 1);
  check('the layer box is closed by default',
    !(await lbox.evaluate((d) => d.open)));
  await lbox.locator('summary').click();
  check('the layer box carries every setting the engine declares',
    await lbox.locator('label').count() >= await page.evaluate(
      () => window.__gs.layerSpec.params.length),
    await lbox.locator('label').count());

  const preBlend = await page.locator('#view').getAttribute('src');
  await lbox.locator('select').first().selectOption('difference');
  await page.waitForFunction((b) => document.querySelector('#view').getAttribute('src') !== b,
    preBlend, { timeout: 240000 });
  check('changing a blend re-renders the artwork', true);
  check('the stack row shows the blend',
    (await page.locator('#stack .lyr').first().textContent()).toLowerCase()
      .includes('difference'),
    await page.locator('#stack .lyr').first().textContent());

  // Selecting a layer must swap the chain strip under it.
  await page.locator('#stack .lyr').last().click();
  await page.waitForFunction((n) => document.querySelectorAll('#chain .node').length === n,
    baseNodes, { timeout: 10000 });
  check('selecting a layer swaps the chain strip to that layer',
    (await page.locator('#chain .node').count()) === baseNodes);
  check('the selected layer is the one marked',
    +await page.locator('#stack .lyr[data-sel=true]').getAttribute('data-i') === 0);

  const preHide = await page.locator('#view').getAttribute('src');
  await page.locator('#stack .lyr').first().locator('.leye').click();
  await page.waitForFunction((b) => document.querySelector('#view').getAttribute('src') !== b,
    preHide, { timeout: 240000 });
  check('hiding a layer changes the artwork', true);
  check('a hidden layer is dimmed',
    await page.locator('#stack .lyr').first().getAttribute('data-off') === 'true');
  await page.locator('#stack .lyr').first().locator('.leye').click();
  await page.waitForTimeout(1500);

  // Solo: what you see is what Keep and the exports use, so this changes the
  // rendered result, not just the view.
  await page.locator('#solo').check();
  await page.waitForFunction(() => window.__gs.composite === false,
    null, { timeout: 240000 });
  check('solo shows the active layer on its own',
    await page.evaluate(() => window.__gs.shownHash
      === window.__gs.layerOut[window.__gs.proj.layers[window.__gs.active].id]));
  await page.locator('#solo').uncheck();
  await page.waitForFunction(() => window.__gs.composite === true,
    null, { timeout: 240000 });
  check('unsoloing goes back to the composite', true);

  const stackH = await page.locator('#stack').evaluate((e) => e.getBoundingClientRect().height);
  check('the layer stack has a fixed height', Math.abs(stackH - 104) < 2, stackH);
  const rowOverlap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#stack .lyr')];
    let bad = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].getBoundingClientRect().top
          < rows[i - 1].getBoundingClientRect().bottom - 1) bad++;
    }
    return bad;
  });
  check('layer rows do not overlap each other', rowOverlap === 0, rowOverlap);
  const stackClip = await page.evaluate(() => {
    const s = document.querySelector('#stack');
    return s.scrollWidth - s.clientWidth;
  });
  check('the stack does not clip its rows sideways', stackClip <= 1, stackClip);

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

  // ---------------------------------------------------------------- zoom ---
  // The stage fits the artwork to a fixed box, which means it is always shown
  // at whatever size that box happens to be. Without a zoom there is no way to
  // pull back from it, which is what "i can't zoom out" meant.
  const artBox = () => page.locator('#view').boundingBox();
  const zoomPct = () => page.textContent('#s-zoom');
  // The artwork is contain-fitted inside an img box that fills the stage, so
  // the img's own rect is not the artwork's. Recover the drawn rect the same
  // way object-fit does, or a non-square design makes the geometry checks lie.
  const contentBox = () => page.locator('#view').evaluate((i) => {
    const r = i.getBoundingClientRect();
    const ar = i.naturalWidth / i.naturalHeight;
    const w = Math.min(r.width, r.height * ar), h = w / ar;
    return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, w, h };
  });

  // The image box must be the stage box. It was not: the stage was a grid with
  // an auto-sized row, height:100% on the image resolved to `auto`, and a
  // square design rendered taller than the stage with its bottom third clipped
  // away -- which is what "i can't zoom out" actually meant.
  const stageAtFit = await page.locator('#stage').boundingBox();
  const imgBox = await page.locator('#view').evaluate(
    (i) => [i.offsetWidth, i.offsetHeight]);
  check('the image box fills the stage exactly',
    Math.abs(imgBox[0] - stageAtFit.width) < 2 && Math.abs(imgBox[1] - stageAtFit.height) < 2,
    `img ${imgBox.join('x')} vs stage ${Math.round(stageAtFit.width)}x${Math.round(stageAtFit.height)}`);

  const shown = await contentBox();
  check('the whole artwork is visible at fit',
    shown.x >= stageAtFit.x - 1 && shown.y >= stageAtFit.y - 1
    && shown.x + shown.w <= stageAtFit.x + stageAtFit.width + 1
    && shown.y + shown.h <= stageAtFit.y + stageAtFit.height + 1,
    `art ${Math.round(shown.x)},${Math.round(shown.y)} ${Math.round(shown.w)}x${Math.round(shown.h)}` +
    ` vs stage ${Math.round(stageAtFit.x)},${Math.round(stageAtFit.y)} ` +
    `${Math.round(stageAtFit.width)}x${Math.round(stageAtFit.height)}`);

  check('zoom controls are present',
    await page.locator('#zout').isVisible() && await page.locator('#zin').isVisible()
    && await page.locator('#zfit').isVisible() && await page.locator('#z11').isVisible());
  check('the viewer opens at fit',
    await page.locator('#zfit').getAttribute('data-on') === 'true');
  check('the zoom readout shows a percentage', /^\d+%$/.test(await zoomPct()),
    await zoomPct());

  const fitBox = await artBox();
  const stagePreZoom = await page.locator('#stage').boundingBox();

  await page.locator('#zout').click();
  await page.waitForTimeout(120);
  const outBox = await artBox();
  check('zoom out shrinks the artwork on screen', outBox.width < fitBox.width - 4,
    `${fitBox.width} -> ${outBox.width}`);

  // The whole reason zoom is a transform: the box it lives in must not resize,
  // or the artwork would shift on screen exactly as it did before the rewrite.
  const stagePostZoom = await page.locator('#stage').boundingBox();
  check('zooming does not move or resize the stage',
    Math.abs(stagePreZoom.x - stagePostZoom.x) < 1 &&
    Math.abs(stagePreZoom.y - stagePostZoom.y) < 1 &&
    Math.abs(stagePreZoom.width - stagePostZoom.width) < 1,
    `${JSON.stringify(stagePreZoom)} -> ${JSON.stringify(stagePostZoom)}`);

  await page.locator('#zout').click();
  await page.waitForTimeout(120);
  const outBox2 = await artBox();
  check('zoom out keeps going', outBox2.width < outBox.width - 4,
    `${outBox.width} -> ${outBox2.width}`);
  check('zoomed out artwork stays inside the stage',
    outBox2.width <= stagePostZoom.width + 1);

  await page.locator('#zin').click();
  await page.waitForTimeout(120);
  check('zoom in grows it again', (await artBox()).width > outBox2.width + 4);

  await page.locator('#zfit').click();
  await page.waitForTimeout(120);
  const backBox = await artBox();
  check('fit restores the original size', Math.abs(backBox.width - fitBox.width) < 2,
    `${fitBox.width} vs ${backBox.width}`);
  check('fit marks itself active',
    await page.locator('#zfit').getAttribute('data-on') === 'true');

  await page.locator('#z11').click();
  await page.waitForTimeout(120);
  check('1:1 reads 100%', (await zoomPct()) === '100%', await zoomPct());
  const oneToOne = await page.locator('#view').evaluate((i) => {
    const r = i.getBoundingClientRect();
    // The artwork is contain-fitted inside the img box, so recover its width.
    const ar = i.naturalWidth / i.naturalHeight;
    return Math.min(r.width, r.height * ar);
  });
  const natW = await page.locator('#view').evaluate((i) => i.naturalWidth);
  check('1:1 really is one image pixel per screen pixel',
    Math.abs(oneToOne - natW) < 2, `${oneToOne} vs ${natW}`);

  // Keyboard and wheel are the two ways anyone actually zooms.
  await page.locator('#zfit').click();
  await page.waitForTimeout(100);
  await page.locator('#stage').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('-');
  await page.waitForTimeout(120);
  check('the minus key zooms out', (await artBox()).width < fitBox.width - 4);
  await page.keyboard.press('0');
  await page.waitForTimeout(120);
  check('the 0 key returns to fit', Math.abs((await artBox()).width - fitBox.width) < 2);

  const sb = await page.locator('#stage').boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(150);
  check('the wheel zooms out over the stage', (await artBox()).width < fitBox.width - 4,
    `${fitBox.width} -> ${(await artBox()).width}`);

  // Nearest-neighbour is right while magnifying and wrong while minifying, so
  // the switch has to follow the magnification readout rather than the zoom
  // factor: fit is already well above 100% for a small source on a big stage.
  const smooth = () => page.locator('#stage').getAttribute('data-smooth');
  for (let i = 0; i < 14 && parseInt(await zoomPct(), 10) >= 100; i++) {
    await page.locator('#zout').click();
    await page.waitForTimeout(60);
  }
  check('zooming out reaches below 100%', parseInt(await zoomPct(), 10) < 100,
    await zoomPct());
  check('minifying turns off nearest-neighbour', (await smooth()) === 'true',
    `${await zoomPct()} smooth=${await smooth()}`);
  await page.locator('#z11').click();
  await page.waitForTimeout(120);
  check('magnifying keeps the pixels crisp', (await smooth()) === 'false',
    `${await zoomPct()} smooth=${await smooth()}`);

  // ----------------------------------------------------------------- pan ---
  await page.locator('#zfit').click();
  await page.waitForTimeout(100);
  for (let i = 0; i < 14 && (await page.locator('#stage').getAttribute('data-pan')) !== 'true'; i++) {
    await page.locator('#zin').click();
    await page.waitForTimeout(60);
  }
  check('zooming in eventually overflows the stage',
    (await page.locator('#stage').getAttribute('data-pan')) === 'true');
  // Stop at the threshold and there is nothing to pan; go well past it.
  for (let i = 0; i < 3; i++) { await page.locator('#zin').click(); await page.waitForTimeout(60); }

  const stageBox = await page.locator('#stage').boundingBox();
  const panBefore = await contentBox();
  // Pan only exists along an axis that actually overflows. The stage is much
  // wider than it is tall, so a square design overflows vertically long before
  // it overflows horizontally, and a sideways drag is correctly clamped dead.
  const overX = panBefore.w > stageBox.width + 1;
  const overY = panBefore.h > stageBox.height + 1;
  check('the zoomed artwork overflows an axis', overX || overY,
    `content ${Math.round(panBefore.w)}x${Math.round(panBefore.h)} ` +
    `stage ${Math.round(stageBox.width)}x${Math.round(stageBox.height)}`);

  const cx = stageBox.x + stageBox.width / 2, cy = stageBox.y + stageBox.height / 2;
  const drag = async (dx, dy) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };

  await drag(overX ? -90 : 0, overY ? -90 : 0);
  const panAfter = await contentBox();
  const moved = Math.abs(panAfter.x - panBefore.x) + Math.abs(panAfter.y - panBefore.y);
  check('dragging pans the zoomed artwork', moved > 20,
    `(${Math.round(panBefore.x)},${Math.round(panBefore.y)}) -> ` +
    `(${Math.round(panAfter.x)},${Math.round(panAfter.y)})`);
  check('a drag on a clamped axis does not move it',
    overX || Math.abs(panAfter.x - panBefore.x) < 1);

  // Drag far past the edge: the artwork must never be flung off the stage.
  await drag(stageBox.width * 4, stageBox.height * 4);
  const flung = await contentBox();
  const coversX = flung.x <= stageBox.x + 1
    && flung.x + flung.w >= stageBox.x + stageBox.width - 1;
  const coversY = flung.y <= stageBox.y + 1
    && flung.y + flung.h >= stageBox.y + stageBox.height - 1;
  check('pan is clamped to the overflow',
    (!overX || coversX) && (!overY || coversY),
    `content y ${Math.round(flung.y)}..${Math.round(flung.y + flung.h)} stage y ` +
    `${Math.round(stageBox.y)}..${Math.round(stageBox.y + stageBox.height)}`);

  await page.locator('#zfit').click();
  await page.waitForTimeout(120);
  const afterFit = await contentBox();
  check('fit recentres the artwork after panning',
    Math.abs((afterFit.x + afterFit.w / 2) - (stageBox.x + stageBox.width / 2)) < 2
    && Math.abs((afterFit.y + afterFit.h / 2) - (stageBox.y + stageBox.height / 2)) < 2,
    `centre (${Math.round(afterFit.x + afterFit.w / 2)},${Math.round(afterFit.y + afterFit.h / 2)})` +
    ` vs (${Math.round(stageBox.x + stageBox.width / 2)},${Math.round(stageBox.y + stageBox.height / 2)})`);

  // A zoom is a view setting, not a chain setting: editing must not throw it
  // away, and it must not survive into an unrelated empty project either.
  await page.locator('#zout').click();
  await page.waitForTimeout(120);
  const heldPct = await zoomPct();
  await page.locator('#library button', { hasText: 'Levels' }).first().click();
  await page.waitForTimeout(1200);
  check('zoom survives adding a node', (await zoomPct()) === heldPct,
    `${heldPct} -> ${await zoomPct()}`);
  await page.locator('#zfit').click();
  await page.waitForTimeout(120);

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

  // ------------------------------------------------- reaching the exports --
  // The export buttons existed for a long time before anyone could get to
  // them: at 1366x768 #ex-gif sat at y=788, and the one gesture that should
  // have brought it up -- a wheel over the variants grid -- was swallowed by
  // that grid's own max-height scroller. "Is it in the DOM" is exactly the
  // check that passed throughout, so these measure reach, not presence.
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(400);

  const nested = await page.evaluate(() =>
    [...document.querySelectorAll('#rail-right *')]
      .filter((e) => e.scrollHeight > e.clientHeight + 2
        && getComputedStyle(e).overflowY === 'auto')
      .map((e) => e.id || e.className));
  check('the right rail has no nested scroller to eat the wheel',
    nested.length === 0, JSON.stringify(nested));

  const rail = page.locator('#rail-right');
  // Put the grid on screen wherever the rail happens to be sitting -- how far
  // down it starts depends on how tall the selected node's inspector is, and
  // wheeling at a coordinate the grid does not occupy tests nothing. Then back
  // off a little so there is definitely somewhere left to scroll to.
  await page.locator('#vgrid').scrollIntoViewIfNeeded();
  await rail.evaluate((r) => { r.scrollTop = Math.max(0, r.scrollTop - 120); });
  await page.waitForTimeout(200);
  const room = await rail.evaluate((r) => r.scrollHeight - r.clientHeight - r.scrollTop);
  const gbox = await page.locator('#vgrid').boundingBox();
  const onScreen = gbox && gbox.y < 768 && gbox.y + gbox.height > 0;
  let railMoved = 0;
  if (onScreen && room > 40) {
    const y = Math.min(760, Math.max(gbox.y + 8, gbox.y + Math.min(30, gbox.height / 2)));
    const from = await rail.evaluate((r) => r.scrollTop);
    await page.mouse.move(gbox.x + gbox.width / 2, y);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(350);
    railMoved = (await rail.evaluate((r) => r.scrollTop)) - from;
  }
  check('one wheel gesture over the variants grid scrolls the rail',
    onScreen && room > 40 && railMoved > 0,
    `onScreen=${onScreen} room=${room} moved=${railMoved}`);

  const folds = await page.locator('details.panel[data-fold]').count();
  check('the rail panels fold', folds === 4, folds);
  await page.evaluate(() => {
    for (const k of ['variants', 'inspector']) {
      document.querySelector(`details.panel[data-fold=${k}]`).open = false;
    }
  });
  await page.waitForTimeout(250);
  await rail.evaluate((r) => { r.scrollTop = 0; });
  const gifBox = await page.locator('#ex-gif').boundingBox();
  check('folding two panels brings GIF into view without scrolling',
    gifBox && gifBox.y >= 0 && gifBox.y + gifBox.height <= 768,
    gifBox && Math.round(gifBox.y));
  check('the fold state is remembered',
    /"variants":false/.test(await page.evaluate(() => localStorage.getItem('gs.folds'))));
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('details.panel[data-fold]')) d.open = true;
  });

  // ------------------------------------------------------- files and links --
  // Nothing evicts stored files any more -- that is the point of them -- so a
  // suite that exports on every run would grow the user's Files list forever.
  // Note what was there before and take back exactly what this run added.
  const filesBefore = new Set((await (await page.request.get(BASE + '/api/files')).json())
    .files.map((f) => f.id));

  const gifDl = page.waitForEvent('download', { timeout: 180000 }).catch(() => null);
  await page.locator('#ex-gif').click();
  check('the GIF export downloads', !!(await gifDl));
  await page.waitForTimeout(500);

  await page.locator('#files').click();
  await page.waitForSelector('#filesdlg[open]', { timeout: 5000 });
  check('the export is listed in Files',
    (await page.locator('#filelist .frow').count()) >= 1);
  // Pick the GIF row by name rather than taking the first: the store is
  // addressed by content, so re-exporting bytes that already exist returns the
  // original entry and keeps its original place in the list. The newest row is
  // whatever was made first, not whatever was exported last.
  const gifRow = page.locator('#filelist .frow', { hasText: '.gif' }).first();
  const link = await gifRow.locator('.flink').textContent();
  check('a file row carries an absolute permanent link',
    /^https?:\/\/.+\/api\/file\/[a-f0-9]{16}$/.test(link || ''), link);
  const linkResp = await page.request.get(link);
  check('the link resolves on its own', linkResp.status() === 200, linkResp.status());
  check('and is served as the type it is',
    (linkResp.headers()['content-type'] || '').includes('gif'),
    linkResp.headers()['content-type']);
  await page.locator('#closefiles').click();

  // ------------------------------------------------------- project as file --
  await page.fill('#projname', 'portable');
  await page.locator('#open').click();
  await page.waitForSelector('#opendlg[open]', { timeout: 5000 });
  const projDl = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
  await page.locator('#savefile').click();
  const projFile = await projDl;
  const projName = projFile ? await projFile.suggestedFilename() : '';
  check('the project saves as a .glitchsheet.json',
    /\.glitchsheet\.json$/.test(projName), projName);
  const projPath = '/tmp/uitest-' + (projName || 'x.json');
  if (projFile) await projFile.saveAs(projPath);
  await page.locator('#closeopen').click();
  await page.waitForTimeout(200);
  const nodesWas = await page.locator('#chain .node').count();

  await page.locator('#newproj').click();
  await page.waitForTimeout(400);
  check('New empties the chain', (await page.locator('#chain .node').count()) === 0);

  await page.locator('#open').click();
  await page.waitForSelector('#opendlg[open]', { timeout: 5000 });
  await page.locator('#projfile').setInputFiles(projPath);
  await page.waitForTimeout(2500);
  check('loading the file restores the chain',
    (await page.locator('#chain .node').count()) === nodesWas,
    `${await page.locator('#chain .node').count()} vs ${nodesWas}`);
  check('loading the file restores the name',
    (await page.inputValue('#projname')) === 'portable');

  // Hand back everything this run made, files and projects both.
  const madeFiles = (await (await page.request.get(BASE + '/api/files')).json())
    .files.map((f) => f.id).filter((id) => !filesBefore.has(id));
  for (const id of madeFiles) await page.request.delete(BASE + '/api/file/' + id);
  const leftOver = (await (await page.request.get(BASE + '/api/files')).json())
    .files.filter((f) => !filesBefore.has(f.id)).length;
  check('the suite leaves no files behind', leftOver === 0, leftOver);
  for (const p of (await (await page.request.get(BASE + '/api/projects')).json()).projects) {
    if (p.name === 'portable') await page.request.delete(BASE + '/api/project/' + p.id);
  }

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
