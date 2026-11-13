// Headless verification of the provisioned spectrogram dashboard: asserts DOM
// state and samples canvas pixels (no screenshot comparison).
//
// Usage: node tools/verify_dashboard.mjs [--base http://localhost:3123]
// Needs the dev stack up with PSD records for the last 24 h (the psd-feed
// service provides them; see db/README.md). Exits non-zero on any failed assertion.

import { chromium } from 'playwright-core';

const base = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://localhost:3123';
const dash = `${base}/d/rf-spectrogram?orgId=1`;
const PANEL_SEL = 'section[class*="panel-container"]';
const CANVAS_SEL = 'canvas[data-testid="spectrogram-canvas"]';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra ? ' -- ' + extra : ''}`);
  if (!cond) {
    failures++;
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 2000 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text().slice(0, 300)));

/** Distinct (coarse) colors + opaque pixel count of each spectrogram canvas. */
const canvasStats = () =>
  page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const ctx = el.getContext('2d');
      if (!ctx || !el.width || !el.height) {
        return { ok: false };
      }
      const d = ctx.getImageData(0, 0, el.width, el.height).data;
      const colors = new Set();
      let opaque = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        if (d[i + 3] === 255) {
          opaque++;
          colors.add(`${d[i] >> 5},${d[i + 1] >> 5},${d[i + 2] >> 5}`);
        }
      }
      return { ok: true, opaque, colors: colors.size };
    });
  }, CANVAS_SEL);

// --- Band panels (Postgres, repeated over $band) -----------------------------
console.log('--- band panels (Postgres, last 24 h) ---');
await page.goto(`${dash}&var-band=$__all&from=now-24h&to=now`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(6000);
const titles = await page
  .locator(PANEL_SEL)
  .evaluateAll((els) => els.map((el) => el.querySelector('h2, [class*="panel-title"]')?.textContent?.trim() ?? ''));
check('4 band panels repeated', titles.filter((t) => /^Band \d/.test(t)).length === 4, JSON.stringify(titles));
const stats = await canvasStats();
check('4 spectrogram canvases', stats.length === 4, `found ${stats.length}`);
stats.forEach((s, i) => {
  check(`band ${i + 1}: canvas has content`, s.ok && s.opaque > 1000, JSON.stringify(s));
  check(`band ${i + 1}: colormap variety`, s.ok && s.colors > 15, JSON.stringify(s));
});
check('no "No PSD data" message', (await page.getByText('No PSD data in this time range').count()) === 0);
check('no synthetic badge', (await page.getByText('synthetic data', { exact: true }).count()) === 0);

// Hover readout draws on the overlay canvas (sibling after the base canvas).
const box = await page.locator(CANVAS_SEL).first().boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(300);
  const white = await page.evaluate((sel) => {
    const el = document.querySelector(sel).nextElementSibling;
    const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) {
        n++;
      }
    }
    return n;
  }, CANVAS_SEL);
  check('hover crosshair + readout drawn', white > 50, `white=${white}`);
} else {
  check('first band canvas has a bounding box', false);
}

// --- Drag to zoom -------------------------------------------------------------
console.log('--- drag to zoom ---');
{
  const b = await page.locator(CANVAS_SEL).first().boundingBox();
  await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(3000);
  const u = new URL(page.url());
  const span = Date.parse(u.searchParams.get('to')) - Date.parse(u.searchParams.get('from'));
  // ~20% of 24 h of plot width -> roughly 4-5 h (plot is narrower than the canvas)
  check(
    'drag selects an absolute range of a few hours',
    span > 3 * 3600e3 && span < 6 * 3600e3,
    `span=${span / 3600e3} h`
  );
  const s2 = await canvasStats();
  check('zoomed panels still render', s2.length === 4 && s2.every((x) => x.ok && x.opaque > 1000), JSON.stringify(s2));
}

// --- Empty time range ---------------------------------------------------------
console.log('--- empty time range ---');
await page.goto(`${dash}&var-band=1&from=0&to=60000`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
check('"No PSD data" shown for an empty range', (await page.getByText('No PSD data in this time range').count()) === 1);

// --- Dev panel 1: synthetic fallback ------------------------------------------
console.log('--- dev panel 1 (synthetic fallback) ---');
await page.goto(`${dash}&viewPanel=panel-1`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
check('synthetic badge shown', (await page.getByText('synthetic data', { exact: true }).count()) === 1);
const s1 = await canvasStats();
check('synthetic canvas has content', s1.length === 1 && s1[0].opaque > 1000, JSON.stringify(s1));

const relevant = pageErrors.filter((e) => !/favicon|ResizeObserver|401|user\/stars/.test(e));
check('no page errors', relevant.length === 0, relevant.slice(0, 5).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
