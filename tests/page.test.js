// Checks on the pages themselves: the things a visitor notices when they break.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('../demo/assets/quote.js');

const DEMO = path.join(__dirname, '..', 'demo');
const pages = {
  'index.html': fs.readFileSync(path.join(DEMO, 'index.html'), 'utf8'),
  'after-launch.html': fs.readFileSync(path.join(DEMO, 'after-launch.html'), 'utf8')
};
const css = fs.readFileSync(path.join(DEMO, 'assets', 'site.css'), 'utf8');
const js = fs.readFileSync(path.join(DEMO, 'assets', 'site.js'), 'utf8');

function attrs(html, name) {
  const out = [];
  const re = new RegExp(name + '="([^"]*)"', 'g');
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

test('both pages carry a title, a description and a viewport', () => {
  for (const [file, html] of Object.entries(pages)) {
    assert.match(html, /<title>[^<]{20,70}<\/title>/, file + ' needs a usable title');
    assert.match(html, /name="description" content="[^"]{80,165}"/, file + ' needs a description');
    assert.match(html, /name="viewport" content="width=device-width/, file + ' needs a viewport');
    assert.match(html, /<html lang="en"/, file + ' needs a language');
  }
});

const FLOWLAB = 'https://flowlab-dev.github.io/work/';

test('nothing is fetched from the internet', () => {
  for (const [file, html] of Object.entries(pages)) {
    for (const value of [...attrs(html, 'src'), ...attrs(html, 'href')]) {
      if (/^(mailto:|tel:|#)/.test(value)) continue;
      // The Flow Lab demo band links to our own site: a link to follow, not a download.
      if (value.startsWith(FLOWLAB)) continue;
      assert.ok(!/^https?:\/\//.test(value), file + ' reaches out to ' + value);
      assert.ok(!/^\/\//.test(value), file + ' reaches out to ' + value);
    }
    assert.ok(!/@import\s+url\(\s*['"]?https?:/.test(html), file + ' imports a remote stylesheet');
  }
  assert.ok(!/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'the stylesheet reaches out');
  assert.ok(!/fetch\(|XMLHttpRequest|new Image\(/.test(js), 'the script makes a request');
});

test('every in-page link lands somewhere that exists', () => {
  for (const [file, html] of Object.entries(pages)) {
    const ids = new Set(attrs(html, 'id'));
    for (const href of attrs(html, 'href')) {
      if (!href.startsWith('#')) continue;
      assert.ok(ids.has(href.slice(1)), file + ' links to ' + href + ', which is not on the page');
    }
    for (const href of attrs(html, 'href')) {
      if (/^(#|mailto:|tel:|data:)/.test(href) || href.startsWith(FLOWLAB)) continue;
      assert.ok(fs.existsSync(path.join(DEMO, href.split('#')[0])), file + ' links to missing file ' + href);
    }
  }
});

test('no id is used twice', () => {
  for (const [file, html] of Object.entries(pages)) {
    const ids = attrs(html, 'id');
    assert.equal(new Set(ids).size, ids.length, file + ' repeats an id');
  }
});

test('every form control has a label and a place for its error', () => {
  const html = pages['index.html'];
  const labelled = new Set(attrs(html, 'for'));
  const controls = [];
  const re = /<(input|select|textarea)\b[^>]*id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) controls.push(m[2]);

  assert.ok(controls.length >= 13, 'expected the full RFQ form, found ' + controls.length);
  for (const id of controls) {
    assert.ok(labelled.has(id), id + ' has no label');
    assert.ok(html.includes('id="err-' + id + '"'), id + ' has nowhere to show an error');
  }
  for (const field of Q.FIELD_ORDER) {
    assert.ok(controls.includes(field), 'the form is missing ' + field);
  }
});

test('the materials and finishes on the page are the ones the engine knows', () => {
  const html = pages['index.html'];
  for (const id of Object.keys(Q.MATERIALS)) {
    assert.ok(html.includes('value="' + id + '"'), 'material ' + id + ' is missing from the form');
  }
  for (const id of Object.keys(Q.FINISHES)) {
    assert.ok(html.includes('value="' + id + '"'), 'finish ' + id + ' is missing from the form');
  }
  for (const id of Object.keys(Q.TOLERANCES)) {
    assert.ok(html.includes('value="' + id + '"'), 'tolerance ' + id + ' is missing from the form');
  }
});

test('the drawing and the example fill agree with each other', () => {
  const html = pages['index.html'];
  assert.ok(html.includes('>390.0<'), 'the drawing should be dimensioned 390');
  assert.ok(html.includes('>220.0<'), 'the drawing should be dimensioned 220');
  assert.ok(/partName: 'Mount bracket NG-2291'/.test(js));
  assert.ok(/length: '390'/.test(js) && /width: '220'/.test(js) && /bends: '2'/.test(js));
  assert.ok(html.includes('NG-2291'), 'the drawing caption should name the same part');
});

test('the numbers quoted in the copy match the engine', () => {
  const html = pages['index.html'];
  assert.ok(html.includes('$' + Q.SHOP.minimumJob), 'the job minimum on the page is not ' + Q.SHOP.minimumJob);
  assert.ok(html.includes(Q.SHOP.sheetMax.length + ' x ' + Q.SHOP.sheetMax.width + ' mm'), 'the bed size does not match');
  assert.ok(html.includes(Q.SHOP.baseLeadDays + ' business days'), 'the lead time does not match');
  assert.ok(html.includes(Math.round(Q.SHOP.rushSurcharge * 100) + ' percent'), 'the rush surcharge does not match');
  const thickest = Math.max(...Object.values(Q.MATERIALS).map(m => Math.max(...m.thickness)));
  assert.ok(html.includes('0.8 - ' + thickest.toFixed(1) + ' mm'), 'the thickness range does not match stock');
});

test('the page is honest about having no server and no clients', () => {
  const html = pages['index.html'];
  assert.ok(/no server behind it/.test(html), 'the form must say where the RFQ actually goes');
  assert.ok(/invented company/.test(html), 'the demo notice must be on the page');
  assert.ok(!/(testimonial|our clients say|trusted by|ISO 9001|award)/i.test(html),
    'no borrowed credibility on a demo');
  for (const [file, html2] of Object.entries(pages)) {
    assert.ok(!/lorem ipsum|placeholder text|coming soon/i.test(html2), file + ' still has filler');
  }
});

test('graphics are described, decoration is hidden from screen readers', () => {
  for (const [file, html] of Object.entries(pages)) {
    const svgs = html.match(/<svg[^>]*>/g) || [];
    for (const tag of svgs) {
      assert.ok(/aria-hidden="true"|role="img"/.test(tag), file + ' has an unlabelled svg: ' + tag);
    }
    assert.ok(html.includes('class="skip-link"'), file + ' needs a skip link');
  }
  assert.ok(pages['index.html'].includes('aria-labelledby="dwg-title dwg-desc"'), 'the drawing needs a description');
});

test('headings run in order, one h1 per page', () => {
  for (const [file, html] of Object.entries(pages)) {
    const levels = (html.match(/<h([1-3])\b/g) || []).map(t => Number(t.slice(2)));
    assert.equal(levels.filter(l => l === 1).length, 1, file + ' needs exactly one h1');
    assert.equal(levels[0], 1, file + ' should open with the h1');
    let previous = 1;
    for (const level of levels) {
      assert.ok(level <= previous + 1, file + ' jumps from h' + previous + ' to h' + level);
      previous = level;
    }
  }
});

test('both themes define the same tokens, and dark is not an inversion', () => {
  const block = name => {
    const start = css.indexOf(name);
    assert.ok(start > -1, 'missing ' + name);
    return css.slice(start, css.indexOf('}', start));
  };
  const names = s => (s.match(/--[a-z-]+:/g) || []).map(t => t.slice(0, -1)).sort();
  const light = block(':root {');
  const dark = block(':root[data-theme="dark"] {');
  const auto = block(':root:not([data-theme="light"]) {');

  const colourTokens = names(light).filter(t => !/--step|--sans|--mono|--gutter|--measure/.test(t));
  assert.deepEqual(names(dark), colourTokens, 'the dark theme skips or invents a token');
  assert.deepEqual(names(auto), colourTokens, 'the system-dark block skips or invents a token');
  assert.notEqual(/--sheet: ([^;]+);/.exec(light)[1], /--sheet: ([^;]+);/.exec(dark)[1]);
});

test('the page respects reduced motion and keyboard focus', () => {
  assert.ok(/prefers-reduced-motion: reduce/.test(css), 'reduced motion is not respected in css');
  assert.ok(/prefers-reduced-motion: reduce/.test(js), 'the drawing animation ignores reduced motion');
  assert.ok(/:focus-visible/.test(css), 'focus is not visible');
  // Tap target sizes are measured in the browser test, not guessed from the css.
});

test('the script keeps no second copy of the shop rates', () => {
  const body = js.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\$150|150 minimum/.test(body), 'the job minimum is written into site.js by hand');
  assert.ok(!/25 percent/.test(body), 'the rush surcharge is written into site.js by hand');
  assert.ok(/Q\.SHOP\.minimumJob|Q\.money\(Q\.SHOP/.test(body), 'site.js should read the minimum from the engine');
  assert.ok(/Q\.SHOP\.rushSurcharge/.test(body), 'site.js should read the surcharge from the engine');
});

test('errors are tied to their field, not only to the colour red', () => {
  assert.ok(/aria-describedby/.test(js), 'an error message should be announced with its field');
  assert.ok(!/in red/.test(js), 'a message must not point at a colour alone');
  assert.ok(/aria-live="polite"/.test(pages['index.html']), 'the estimate needs a spoken summary');
});

test('the script and the pages load the same engine', () => {
  for (const [file, html] of Object.entries(pages)) {
    assert.ok(html.includes('<script src="assets/quote.js"></script>'), file + ' does not load the engine');
    assert.ok(html.indexOf('assets/quote.js') < html.indexOf('assets/site.js'), file + ' loads them in the wrong order');
  }
});

test('the monthly plan is on the site and priced', () => {
  const care = pages['after-launch.html'];
  assert.ok(pages['index.html'].includes('after-launch.html'), 'the main page should link to the plan');
  assert.match(care, /\$\d+ per month/);
  assert.ok(/does not cover|What it does not cover/i.test(care), 'the plan must say what it excludes');
  assert.ok(/cancel at the end of any month/i.test(care), 'the plan must say how to cancel');
});

test('a field border is visible enough to find', () => {
  const channel = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const token = (block, name) => {
    const start = css.indexOf(block);
    const scope = css.slice(start, css.indexOf('}', start));
    return new RegExp('--' + name + ': (#[0-9a-f]{6});').exec(scope)[1];
  };

  for (const block of [':root {', ':root[data-theme="dark"] {', ':root:not([data-theme="light"]) {']) {
    const border = token(block, 'rule-strong');
    const field = token(block, 'sheet');
    const panel = token(block, 'panel');
    assert.ok(ratio(border, field) >= 3,
      block + ' border ' + border + ' on ' + field + ' is only ' + ratio(border, field).toFixed(2) + ':1');
    assert.ok(ratio(border, panel) >= 3,
      block + ' border ' + border + ' on ' + panel + ' is only ' + ratio(border, panel).toFixed(2) + ':1');
  }
});

test('the monthly plan names its price and its hourly rate exactly', () => {
  const care = pages['after-launch.html'];
  assert.ok(care.includes('$120 per month'), 'the plan must print $120 per month');
  assert.ok(care.includes('$50 an hour'), 'the plan must print $50 an hour');
  assert.ok(care.includes('cancel at the end of any month'), 'how to cancel must stay on the page');
});
