// Screenshot the provisioned dashboard (or any Grafana path) headlessly.
// Usage: node tools/screenshot.mjs OUT.png [path-and-query] [--base URL] [--height N] [--hover x,y]
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = args[0] ?? 'dashboard.png';
const path = args[1] && !args[1].startsWith('--') ? args[1] : '/d/rf-spectrogram?orgId=1&kiosk';
const base = opt('--base', 'http://localhost:3123');

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: Number(opt('--height', 1400)) } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(base + path, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(5000);
const hover = opt('--hover', '');
if (hover) {
  const [x, y] = hover.split(',').map(Number);
  await page.mouse.move(x, y);
  await page.waitForTimeout(300);
}
await page.screenshot({ path: out });
console.log(`wrote ${out}`);
if (errors.length) {
  console.log('console errors:\n  ' + errors.slice(0, 10).join('\n  '));
}
await browser.close();
