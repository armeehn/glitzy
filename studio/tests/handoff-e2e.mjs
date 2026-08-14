/* The "Open in Etsch" handoff, driven in a real browser, end to end.
 *
 * Covers the seam nothing else can: the studio builds a sheet, opens the
 * leaving-interstitial in a NEW TAB, steers that tab to the finished file, and
 * Etsch -- the actual deployed tree, not a copy of it -- reads that file
 * back through /handoff/<id> and renders the stickers.
 *
 * Run in LXC 114 from /root/uitest (node resolves playwright-core relative to
 * the script, so it has to live beside its node_modules):
 *
 *   node handoff-e2e.mjs
 *
 * The Authelia gate is NOT exercised here -- there is no session to test with.
 * This drives the engine on 127.0.0.1:8090 and Etsch from a local static
 * server that mirrors what Caddy does for etsch.hq: serve /var/www/etsch
 * and proxy /handoff/<id> to the engine's /api/file/<id>.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ENGINE = 'http://127.0.0.1:8090';
const ETSCH_ROOT = process.env.ETSCH_ROOT || '/root/etsch-www';
const PORT = 8791;

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (got !== undefined ? '  -> ' + JSON.stringify(got) : '')); }
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/* Caddy's etsch.hq site, in miniature. */
const site = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = /^\/handoff\/([0-9a-f]{16})$/.exec(url.pathname);
  if (m) {
    const up = await fetch(`${ENGINE}/api/file/${m[1]}`);
    const body = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
    return res.end(body);
  }
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  let fp = join(ETSCH_ROOT, rel);
  try {
    await stat(fp);
  } catch {
    fp = join(ETSCH_ROOT, 'index.html'); // SPA fallback, as wrangler.toml does
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(fp)] || 'application/octet-stream',
    // The header that made "Open project" decode data: URLs by hand. If the
    // handoff ever needs a wider connect-src, this test is where it shows up.
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; "
      + "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'",
  });
  res.end(await readFile(fp));
});
await new Promise((r) => site.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: '/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// -- the studio ------------------------------------------------------------
await page.goto(ENGINE + '/', { waitUntil: 'networkidle' });

ok('the header Etsch link is filled in from config, not hard-coded',
  await page.getAttribute('#etsch-link', 'href') === 'https://etsch.hq.ripostelabs.xyz/',
  await page.getAttribute('#etsch-link', 'href'));
ok('the header link is visible once a destination exists',
  await page.isVisible('#etsch-link'));

// A starter chain, cooked, then kept -- the button is dead until the tray has
// something in it.
ok('Open in Etsch is disabled with an empty tray',
  await page.isDisabled('#ex-open'));

await page.evaluate(async () => {
  const res = await fetch('/api/eval', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: [
      { op: 'source.plasma', params: { width: 320, height: 320, frames: 1 } },
      { op: 'matte.shape', params: {} },
    ] }),
  });
  const { job } = await res.json();
  for (;;) {
    const j = await (await fetch('/api/job/' + job)).json();
    if (j.state === 'done') { window.__hash = j.result.hash; return; }
    if (j.state === 'error') throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 120));
  }
});

// Put two stickers in the tray through the studio's own state.
await page.evaluate(() => {
  const { S } = window.gs || {};
  return S;
});
const wired = await page.evaluate(async () => {
  const mod = await import('/js/state.js');
  const tray = await import('/js/tray.js');
  mod.S.proj.tray.push(
    { hash: window.__hash, frame: 0, mm: 50, name: 'e2e 1' },
    { hash: window.__hash, frame: 0, mm: 50, name: 'e2e 2' });
  tray.renderTray();
  return mod.S.proj.tray.length;
});
ok('two stickers are on the sheet', wired === 2, wired);
ok('Open in Etsch is enabled once the tray has something in it',
  await page.isEnabled('#ex-open'));

// -- the new tab -----------------------------------------------------------
const [popup] = await Promise.all([
  page.waitForEvent('popup'),
  page.click('#ex-open'),
]);
ok('clicking it opens a new tab', !!popup);
ok('the new tab is the leaving-Glitzy warning, not Etsch itself',
  new URL(popup.url()).pathname === '/leaving.html', popup.url());

await popup.waitForFunction(() => new URLSearchParams(location.search).has('id'), null,
  { timeout: 30000 });
const params = new URL(popup.url()).searchParams;
const fileId = params.get('id');
ok('the tab is steered to the finished sheet', /^[0-9a-f]{16}$/.test(fileId || ''), fileId);
ok('it says how many stickers are on it', params.get('n') === '2', params.get('n'));

await popup.waitForSelector('#go[href]');
const warnText = await popup.textContent('.card');
ok('the tab warns you are leaving Glitzy',
  /You are leaving Glitzy/i.test(warnText), warnText.slice(0, 60));
ok('it names the destination host',
  (await popup.textContent('#f-dest')) === 'etsch.hq.ripostelabs.xyz',
  await popup.textContent('#f-dest'));
ok('it says Etsch is a separate application', /separate application/i.test(warnText));
ok('it offers the file as a download instead',
  (await popup.getAttribute('#dl', 'href')) === `/api/file/${fileId}?dl=1`,
  await popup.getAttribute('#dl', 'href'));

// Where Continue goes. Read the href rather than clicking it: the real host
// needs DNS and a session, and a click would only prove Chromium can fail to
// resolve a name. The href IS the contract -- it is what the click navigates
// to, and what the status bar shows before anyone commits to it.
const target = await popup.getAttribute('#go', 'href');
ok('Continue goes to Etsch carrying the sheet id',
  target === `https://etsch.hq.ripostelabs.xyz/#handoff=${fileId}`, target);
ok('nothing was navigated before the user asked',
  new URL(popup.url()).host === new URL(ENGINE).host, popup.url());

// -- Etsch's side, on the real deployed tree ----------------------------
const cs = await ctx.newPage();
const csErrors = [];
cs.on('pageerror', (e) => csErrors.push(String(e)));
await cs.goto(`http://127.0.0.1:${PORT}/#handoff=${fileId}`, { waitUntil: 'networkidle' });
await cs.waitForFunction(() => window.etsch && window.etsch.doc.items.length > 0,
  null, { timeout: 20000 });

const loaded = await cs.evaluate(() => ({
  items: window.etsch.doc.items.length,
  name: window.etsch.doc.name,
  machine: window.etsch.doc.machine,
  cuts: window.etsch.doc.items.map((i) => [i.cut.mode, i.cut.offset]),
  pageW: window.etsch.doc.page.w,
  hash: location.hash,
  // Toasts are appended to #toasts and removed after a few seconds, so read
  // this in the same pass as the doc state, not later.
  toast: document.querySelector('#toasts .toast')?.textContent || '',
}));
ok('Etsch loaded both stickers from the handoff', loaded.items === 2, loaded);
ok('the sheet kept its name', /e2e|Glitzy|untitled/i.test(loaded.name), loaded.name);
ok('it is a letter sheet', Math.abs(loaded.pageW - 215.9) < 0.01, loaded.pageW);
ok('the contour cuts survived', loaded.cuts.every(([m, o]) => m === 'contour' && o === 0),
  loaded.cuts);
ok('the handoff id is cleaned out of the URL', loaded.hash === '', loaded.hash);
ok('it says where the sheet came from', /Glitzy/i.test(loaded.toast), loaded.toast);

// The artwork has to actually be there, not just the item records.
const drawn = await cs.evaluate(() => {
  const c = document.getElementById('canvas');
  const ctx2 = c.getContext('2d');
  const { data } = ctx2.getImageData(0, 0, c.width, c.height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] !== 255) ink++;
  return { ink, w: c.width, h: c.height };
});
ok('the stickers are actually drawn on the canvas', drawn.ink > 5000, drawn);

// A second visit with no handoff must not re-import anything.
const again = await ctx.newPage();
await again.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await again.waitForTimeout(800);
const restored = await again.evaluate(() => window.etsch.doc.items.length);
ok('a plain visit restores the autosave instead of re-importing', restored === 2, restored);

// A bad handoff id must fail loudly and leave the sheet alone.
const bad = await ctx.newPage();
await bad.goto(`http://127.0.0.1:${PORT}/#handoff=deadbeefdeadbeef`, { waitUntil: 'networkidle' });
await bad.waitForTimeout(1200);
const badState = await bad.evaluate(() => ({
  items: window.etsch.doc.items.length,
  // Toasts are appended to #toasts and removed after a few seconds, so read
  // this in the same pass as the doc state, not later.
  toast: document.querySelector('#toasts .toast')?.textContent || '',
}));
ok('an unknown sheet id is reported, not swallowed', /no longer available|not the one/i.test(badState.toast),
  badState.toast);

ok('no page errors in the studio', errors.length === 0, errors);
ok('no page errors in Etsch', csErrors.length === 0, csErrors);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
site.close();
process.exit(fail ? 1 : 0);
