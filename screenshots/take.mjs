// Takes the portfolio frames: same page, different widths, themes and states.
// Headless Chrome over the DevTools protocol, no packages, no window on screen.
//
//   node screenshots/take.mjs          (CHROME_PATH=/path/to/chrome if Chrome lives somewhere else)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const url = (file) => pathToFileURL(path.join(HERE, '..', 'demo', file)).href;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9800 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILL = `
  const set = (id, value) => {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  document.getElementById('fill-example').click();
  set('contactName', 'Dana Reyes');
  set('company', 'Reyes Fabrication');
  set('email', 'dana@example.com');
`;

const SHOTS = [
  { name: '01-hero-light', file: 'index.html', theme: 'light', w: 1440, h: 900 },
  { name: '02-hero-dark', file: 'index.html', theme: 'dark', w: 1440, h: 900 },
  { name: '03-capability-light', file: 'index.html', theme: 'light', w: 1440, h: 900, scrollTo: '#work' },
  { name: '04-process-dark', file: 'index.html', theme: 'dark', w: 1440, h: 900, scrollTo: '#how' },
  { name: '05-form-empty-light', file: 'index.html', theme: 'light', w: 1440, h: 980, scrollTo: '#rfq' },
  { name: '06-estimate-live-light', file: 'index.html', theme: 'light', w: 1440, h: 980, scrollTo: '#rfq', run: FILL },
  { name: '07-estimate-live-dark', file: 'index.html', theme: 'dark', w: 1440, h: 980, scrollTo: '#rfq', run: FILL },
  {
    name: '08-errors-light',
    file: 'index.html',
    theme: 'light',
    w: 1440,
    h: 980,
    scrollTo: '#rfq',
    run: `
      const q = document.getElementById('quantity');
      q.value = '0';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('rfq-form').requestSubmit();
    `,
  },
  {
    name: '09-rfq-ready-light',
    file: 'index.html',
    theme: 'light',
    w: 1440,
    h: 980,
    scrollTo: '#receipt',
    run: FILL + `
      document.getElementById('rfq-form').requestSubmit();
    `,
  },
  { name: '10-answers-light', file: 'index.html', theme: 'light', w: 1440, h: 900, scrollTo: '#answers' },
  { name: '11-after-launch-light', file: 'after-launch.html', theme: 'light', w: 1440, h: 900 },
  { name: '12-after-launch-dark', file: 'after-launch.html', theme: 'dark', w: 1440, h: 900, scrollTo: '.price-line' },
  { name: '13-phone-hero-light', file: 'index.html', theme: 'light', w: 375, h: 812, scale: 2 },
  { name: '14-phone-estimate-dark', file: 'index.html', theme: 'dark', w: 375, h: 812, scale: 2, scrollTo: '#rfq', run: FILL },
];

const profile = mkdtempSync(path.join(tmpdir(), 'ng-shots-'));
const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60 && !target; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { /* still starting */ }
  if (!target) await sleep(200);
}
if (!target) throw new Error('Chrome did not open a debugging port');

const ws = new WebSocket(target.webSocketDebuggerUrl);
const waiting = new Map();
let id = 0;
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

function send(method, params = {}) {
  id += 1;
  const current = id;
  return new Promise((resolve, reject) => {
    waiting.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
  });
}

const evaluate = (expression) => send('Runtime.evaluate', {
  expression: `(function(){${expression}})()`,
  returnByValue: true,
});

await send('Page.enable');
await send('Runtime.enable');

for (const shot of SHOTS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: shot.w, height: shot.h, deviceScaleFactor: shot.scale || 1, mobile: shot.w < 700,
  });
  // The theme is stored the way a visitor stores it, then the page is loaded
  // again, so the switch in the masthead shows the state it is really in.
  await send('Page.navigate', { url: url(shot.file) });
  await sleep(600);
  await evaluate(`try { localStorage.setItem('ng-theme', '${shot.theme}'); } catch (e) {}`);
  await send('Page.navigate', { url: url(shot.file) });
  await sleep(1100);
  if (shot.run) await evaluate(shot.run);

  // Scroll the page for real and photograph the viewport: that is what a
  // visitor sees, sticky masthead included and never sliced in half.
  if (shot.scrollTo) {
    await evaluate(`
      const el = document.querySelector('${shot.scrollTo}');
      if (el) {
        const head = document.querySelector('.masthead');
        const stuck = head && getComputedStyle(head).position === 'sticky' ? head.getBoundingClientRect().height : 0;
        // Land the target exactly under the masthead: no slice of the block above.
        window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - stuck), behavior: 'instant' });
      }
    `);
  }
  await sleep(500);
  const png = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(HERE, shot.name + '.png');
  writeFileSync(out, Buffer.from(png.data, 'base64'));
  console.log('ok ' + shot.name + ' (' + shot.w + 'x' + shot.h + ')');
}

ws.close();
chrome.kill('SIGKILL');
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(0);
