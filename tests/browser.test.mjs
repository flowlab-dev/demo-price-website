// The page driven in a real browser: console clean, form behaving, no
// sideways scroll on a phone. Headless Chrome over the DevTools protocol,
// no packages.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(path.join(HERE, '..', 'demo', 'index.html')).href;
// Chrome where macOS keeps it, or wherever CHROME_PATH points.
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  test('browser checks', { skip: 'Chrome not found at ' + CHROME + ' - set CHROME_PATH to run these' }, () => {});
  process.exit(0);
}
const PORT = 9600 + Math.floor(Math.random() * 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome; let ws; let profile; let id = 0;
const waiting = new Map();
const consoleProblems = [];

function send(method, params = {}) {
  id += 1;
  const current = id;
  return new Promise((resolve, reject) => {
    waiting.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression: `(function(){${expression}})()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error('page threw: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result.value;
}

async function open(width = 1280, height = 900) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 700,
  });
  await send('Page.navigate', { url: PAGE });
  await sleep(900);
}

before(async () => {
  profile = mkdtempSync(path.join(tmpdir(), 'ng-chrome-'));
  chrome = spawn(CHROME, [
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
  assert.ok(target, 'Chrome did not open a debugging port');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
      consoleProblems.push(msg.params.entry.level + ': ' + msg.params.entry.text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleProblems.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await open();
});

after(() => {
  try { ws?.close(); } catch { /* already gone */ }
  chrome?.kill('SIGKILL');
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the page loads with an empty console', async () => {
  await open();
  assert.deepEqual(consoleProblems, []);
  assert.equal(await evaluate('return document.title.length > 10;'), true);
});

test('the estimate panel waits until it has enough to say', async () => {
  await open();
  assert.equal(await evaluate('return document.getElementById("estimate-state").textContent;'), 'waiting');
  assert.equal(await evaluate('return document.getElementById("estimate-figures").hidden;'), true);
});

test('the example fills the form and the estimate comes alive', async () => {
  await open();
  const result = await evaluate(`
    document.getElementById('fill-example').click();
    return {
      state: document.getElementById('estimate-state').textContent,
      range: document.getElementById('estimate-range').textContent,
      lead: document.getElementById('row-lead').textContent,
      flags: document.getElementById('estimate-flags').children.length,
      focused: document.activeElement.id
    };
  `);
  assert.equal(result.state, 'live');
  assert.match(result.range, /^\$[\d,]+\.\d\d - \$[\d,]+\.\d\d$/);
  assert.equal(result.lead, '8 business days');
  assert.ok(result.flags >= 2);
  assert.equal(result.focused, 'contactName', 'the example should leave the cursor where the person continues');
});

test('typing a quantity moves the number', async () => {
  await open();
  const [before50, after500] = await evaluate(`
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.getElementById('fill-example').click();
    const first = document.getElementById('estimate-range').textContent;
    set('quantity', '500');
    return [first, document.getElementById('estimate-range').textContent];
  `);
  assert.notEqual(before50, after500);
});

test('an empty form is refused with errors people can act on', async () => {
  await open();
  const result = await evaluate(`
    document.getElementById('rfq-form').requestSubmit();
    const fields = [...document.querySelectorAll('.field.is-bad')];
    const bad = fields.map(f => f.querySelector('.error').textContent);
    const names = fields.map(f => f.querySelector('input, select, textarea').id);
    return {
      alert: document.getElementById('form-alert').textContent,
      alertShown: document.getElementById('form-alert').classList.contains('is-on'),
      bad,
      names,
      focused: document.activeElement.id,
      receiptShown: document.getElementById('receipt').classList.contains('is-on')
    };
  `);
  assert.equal(result.alertShown, true);
  assert.match(result.alert, /fields need fixing/);
  // Material, thickness, finish and tolerance are dropdowns that always hold a
  // usable value, so an empty form can only be wrong in these six places.
  assert.deepEqual(result.names, ['partName', 'length', 'width', 'quantity', 'contactName', 'email']);
  assert.ok(result.bad.every((m) => m.length > 8));
  assert.equal(result.focused, 'partName', 'focus should land on the first field to fix');
  assert.equal(result.receiptShown, false);
});

test('fixing a field clears its error as you type', async () => {
  await open();
  const stillBad = await evaluate(`
    document.getElementById('rfq-form').requestSubmit();
    const el = document.getElementById('partName');
    el.value = 'Mount bracket';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.closest('.field').classList.contains('is-bad');
  `);
  assert.equal(stillBad, false);
});

test('a complete RFQ produces a reference, a text block and a mailto', async () => {
  await open();
  const result = await evaluate(`
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.getElementById('fill-example').click();
    set('contactName', 'Dana Reyes');
    set('email', 'dana@example.com');
    document.getElementById('rfq-form').requestSubmit();
    return {
      shown: document.getElementById('receipt').classList.contains('is-on'),
      ref: document.getElementById('receipt-ref').textContent,
      text: document.getElementById('receipt-text').textContent,
      mail: document.getElementById('receipt-mail').getAttribute('href'),
      bad: document.querySelectorAll('.field.is-bad').length
    };
  `);
  assert.equal(result.bad, 0);
  assert.equal(result.shown, true);
  assert.match(result.ref, /^NG-\d{6}-[A-HJ-NP-Z]{2}\d{2}$/);
  assert.ok(result.text.includes(result.ref));
  assert.ok(result.text.includes('Mount bracket NG-2291'));
  assert.ok(result.mail.startsWith('mailto:quotes@northgatemetalworks.example?subject='));
  assert.ok(result.mail.includes(encodeURIComponent(result.ref)));
});

test('the thickness list follows the material', async () => {
  await open();
  const result = await evaluate(`
    const material = document.getElementById('material');
    const read = () => [...document.getElementById('thickness').options].map(o => o.value);
    const steel = read();
    material.value = 'ss304';
    material.dispatchEvent(new Event('change', { bubbles: true }));
    const stainless = read();
    material.value = 'al5052';
    material.dispatchEvent(new Event('change', { bubbles: true }));
    return { steel, stainless, aluminium: read() };
  `);
  assert.ok(result.steel.includes('6'));
  assert.ok(!result.stainless.includes('6'), 'stainless stops at 5 mm');
  assert.ok(!result.aluminium.includes('0.8'), 'aluminium starts at 1 mm');
});

test('the theme toggle switches the page and remembers the choice', async () => {
  await open();
  const result = await evaluate(`
    const btn = document.getElementById('theme-toggle');
    const root = document.documentElement;
    const before = getComputedStyle(document.body).backgroundColor;
    btn.click();
    const first = { theme: root.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor, label: document.getElementById('theme-label').textContent };
    btn.click();
    return { before, first, second: root.getAttribute('data-theme'), stored: localStorage.getItem('ng-theme') };
  `);
  assert.notEqual(result.before, result.first.bg, 'the colours should actually change');
  assert.ok(['dark', 'light'].includes(result.first.theme));
  assert.notEqual(result.first.theme, result.second);
  assert.equal(result.stored, result.second);
  assert.ok(['Day shift', 'Night shift'].includes(result.first.label));
});

test('nothing scrolls sideways on a 375 pixel phone', async () => {
  await open(375, 812);
  const result = await evaluate(`
    document.getElementById('fill-example').click();
    const wide = [...document.querySelectorAll('body *')]
      .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 5)
      .map(el => el.tagName + '.' + (el.className || '').toString().split(' ')[0]);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      wide
    };
  `);
  assert.deepEqual(result.wide, [], 'these elements stick out: ' + result.wide.join(', '));
  assert.ok(result.scrollWidth <= result.clientWidth + 1,
    'page is ' + result.scrollWidth + 'px wide in a ' + result.clientWidth + 'px window');
});

test('tap targets on a phone are big enough to hit', async () => {
  await open(375, 812);
  const small = await evaluate(`
    return [...document.querySelectorAll('a.btn, button, .nav a, summary, select, input')]
      .map(el => ({ el: el.tagName + '#' + (el.id || el.className), h: el.getBoundingClientRect().height }))
      .filter(x => x.h > 0 && x.h < 44);
  `);
  assert.deepEqual(small, [], 'too small to tap: ' + JSON.stringify(small));
});

test('the after-launch page loads clean too', async () => {
  await send('Page.navigate', { url: PAGE.replace('index.html', 'after-launch.html') });
  await sleep(900);
  const problems = consoleProblems.slice();
  assert.deepEqual(problems, []);
  assert.equal(await evaluate('return document.querySelectorAll(".care-block").length;'), 4);
  assert.equal(await evaluate('return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;'), true);
});

test('on a phone the price stays in view while the form is filled in', async () => {
  await open(375, 812);
  const result = await evaluate(`
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.getElementById('fill-example').click();
    set('quantity', '120');
    document.getElementById('notes').scrollIntoView({ block: 'center', behavior: 'instant' });
    const panel = document.querySelector('.estimate-panel').getBoundingClientRect();
    return {
      top: Math.round(panel.top),
      height: Math.round(panel.height),
      range: document.getElementById('estimate-range').textContent,
      leadVisible: getComputedStyle(document.getElementById('row-lead').parentElement).display !== 'none'
    };
  `);
  assert.ok(result.top >= 0 && result.top < 70, 'the panel should be pinned near the top, it was at ' + result.top);
  assert.ok(result.height < 300, 'the pinned panel should stay compact, it was ' + result.height + 'px');
  assert.match(result.range, /^\$[\d,]+\.\d\d - \$[\d,]+\.\d\d$/);
  assert.equal(result.leadVisible, true, 'the ready-in line should survive the cut');
});

test('a finished RFQ does not outlive the numbers it was built from', async () => {
  await open();
  const result = await evaluate(`
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.getElementById('fill-example').click();
    set('contactName', 'Dana Reyes');
    set('email', 'dana@example.com');
    document.getElementById('rfq-form').requestSubmit();
    const shownFirst = document.getElementById('receipt').classList.contains('is-on');
    const priceFirst = document.getElementById('estimate-range').textContent;
    set('quantity', '400');
    return {
      shownFirst,
      priceFirst,
      priceNow: document.getElementById('estimate-range').textContent,
      shownNow: document.getElementById('receipt').classList.contains('is-on')
    };
  `);
  assert.equal(result.shownFirst, true);
  assert.notEqual(result.priceNow, result.priceFirst, 'the estimate should follow the new quantity');
  assert.equal(result.shownNow, false, 'the old RFQ must not sit under a price that has changed');
});

test('the example does not wipe what the person already typed', async () => {
  await open();
  const result = await evaluate(`
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('contactName', 'Dana Reyes');
    set('email', 'dana@example.com');
    set('notes', 'Tapped M6 after forming.');
    document.getElementById('fill-example').click();
    return {
      name: document.getElementById('contactName').value,
      email: document.getElementById('email').value,
      notes: document.getElementById('notes').value,
      part: document.getElementById('partName').value
    };
  `);
  assert.equal(result.name, 'Dana Reyes');
  assert.equal(result.email, 'dana@example.com');
  assert.equal(result.notes, 'Tapped M6 after forming.');
  assert.equal(result.part, 'Mount bracket NG-2291');
});

test('a blocked estimate says what is blocking it', async () => {
  await open();
  const result = await evaluate(`
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.getElementById('fill-example').click();
    set('length', '4000');
    return {
      state: document.getElementById('estimate-state').textContent,
      message: document.getElementById('estimate-empty').textContent,
      figuresHidden: document.getElementById('estimate-figures').hidden
    };
  `);
  assert.equal(result.state, 'on hold');
  assert.match(result.message, /bed is 3000 x 1500 mm/);
  assert.equal(result.figuresHidden, true);
});

test('the after-launch page works on a phone too', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: PAGE.replace('index.html', 'after-launch.html') });
  await sleep(900);
  const result = await evaluate(`
    const small = [...document.querySelectorAll('a.btn, button, .nav a, summary')]
      .map(el => ({ el: el.tagName + '#' + (el.id || el.className), h: el.getBoundingClientRect().height }))
      .filter(x => x.h > 0 && x.h < 44);
    const before = getComputedStyle(document.body).backgroundColor;
    document.getElementById('theme-toggle').click();
    return {
      small,
      themeChanged: getComputedStyle(document.body).backgroundColor !== before,
      wide: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    };
  `);
  assert.deepEqual(result.small, [], 'too small to tap: ' + JSON.stringify(result.small));
  assert.equal(result.themeChanged, true, 'the switch should work on the second page as well');
  assert.equal(result.wide, true);
});

test('the pinned panel uses the whole width of a phone', async () => {
  await open(375, 812);
  const result = await evaluate(`
    document.getElementById('fill-example').click();
    const panel = document.querySelector('.estimate-panel').getBoundingClientRect();
    const form = document.getElementById('rfq-form').getBoundingClientRect();
    return { panel: Math.round(panel.width), form: Math.round(form.width) };
  `);
  assert.equal(result.panel, result.form, 'the panel and the form should share the same column');
});

test('no block of text is squeezed into a one-word column', async () => {
  // The bug this catches: a paragraph auto-placed into a narrow grid column
  // reads one word per line and looks broken on a wide screen.
  for (const width of [1280, 1440, 1920]) {
    await open(width, 900);
    const narrow = await evaluate(`
      return [...document.querySelectorAll('main p, main li, .care-block li')]
        .filter(el => el.textContent.trim().split(/\\s+/).length >= 8)
        .map(el => ({
          where: (el.closest('section') || {}).id || 'page',
          text: el.textContent.trim().slice(0, 40),
          width: Math.round(el.getBoundingClientRect().width)
        }))
        .filter(x => x.width > 0 && x.width < 240);
    `);
    assert.deepEqual(narrow, [], 'squeezed at ' + width + 'px: ' + JSON.stringify(narrow));
  }

  for (const width of [1280, 1920]) {
    await send('Page.navigate', { url: PAGE.replace('index.html', 'after-launch.html') });
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const narrow = await evaluate(`
      return [...document.querySelectorAll('main p, main li')]
        .filter(el => el.textContent.trim().split(/\\s+/).length >= 8)
        .map(el => ({ text: el.textContent.trim().slice(0, 40), width: Math.round(el.getBoundingClientRect().width) }))
        .filter(x => x.width > 0 && x.width < 240);
    `);
    assert.deepEqual(narrow, [], 'squeezed on the second page at ' + width + 'px: ' + JSON.stringify(narrow));
  }
});
