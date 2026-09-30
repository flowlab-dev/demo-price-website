// The reference number and the plain-text RFQ a buyer pastes into email.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Q = require('../demo/assets/quote.js');

const NOW = new Date(2026, 8, 23, 9, 0, 0).getTime(); // Wednesday, on the visitor's own clock

function values(extra) {
  const r = Q.validate(Object.assign({
    partName: 'Mount bracket NG-2291',
    material: 'crs',
    thickness: '2.0',
    length: '390',
    width: '220',
    quantity: '50',
    bends: '2',
    holes: '5',
    finish: 'powder',
    tolerance: 'standard',
    contactName: 'Dana Reyes',
    company: 'Reyes Fabrication',
    email: 'dana@example.com'
  }, extra || {}), NOW);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.values;
}

test('the reference carries the date and is stable for the same part', () => {
  const ref = Q.reference(values(), NOW);
  assert.match(ref, /^NG-260923-[A-HJ-NP-Z]{2}\d{2}$/);
  assert.equal(ref, Q.reference(values(), NOW));
});

test('a different part gets a different reference', () => {
  const a = Q.reference(values(), NOW);
  const b = Q.reference(values({ quantity: '51' }), NOW);
  const c = Q.reference(values({ email: 'sam@example.com' }), NOW);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('letters that get misread on the phone stay out of the reference', () => {
  const seen = new Set();
  for (let i = 1; i <= 200; i++) {
    seen.add(Q.reference(values({ quantity: String(i) }), NOW).slice(10, 12));
  }
  for (const pair of seen) {
    assert.ok(!/[IO]/.test(pair), 'reference should avoid I and O, got ' + pair);
  }
});

test('the summary says everything the shop needs to quote', () => {
  const v = values({ neededBy: '2026-10-20', notes: 'Holes tapped M6 after forming.' });
  const e = Q.estimate(v, NOW);
  const ref = Q.reference(v, NOW);
  const text = Q.summaryText(v, e, ref);

  for (const line of [
    ref,
    'Mount bracket NG-2291',
    'Mild steel (CRS 1008), 2 mm',
    '390 x 220 mm',
    'Powder coat, one colour',
    'Standard, +/-0.25 mm',
    '20 Oct 2026',
    'Dana Reyes, Reyes Fabrication',
    'dana@example.com',
    'Holes tapped M6 after forming.'
  ]) {
    assert.ok(text.includes(line), 'summary is missing: ' + line);
  }
  assert.ok(text.includes(Q.priceRange(e)));
  assert.ok(/business days/.test(text));
});

test('the summary never pretends the estimate is a quote', () => {
  const v = values();
  const text = Q.summaryText(v, Q.estimate(v, NOW), Q.reference(v, NOW));
  assert.ok(/not from a drawing/.test(text));
  assert.ok(/one business day/.test(text));
});

test('rush and minimum show up in the text, and stay away when they do not apply', () => {
  const rushed = values({ neededBy: '2026-09-28' });
  const rushText = Q.summaryText(rushed, Q.estimate(rushed, NOW), 'NG-260923-AA00');
  assert.ok(/Rush:/.test(rushText));

  const small = values({ quantity: '1', bends: '0', holes: '0', length: '120', width: '80', finish: 'mill' });
  const smallText = Q.summaryText(small, Q.estimate(small, NOW), 'NG-260923-AA00');
  assert.ok(/job minimum/.test(smallText));

  const plain = values();
  const plainText = Q.summaryText(plain, Q.estimate(plain, NOW), 'NG-260923-AA00');
  assert.ok(!/Rush:/.test(plainText));
  assert.ok(!/job minimum/.test(plainText));
});

test('the summary stays plain ASCII so it survives email and copy-paste', () => {
  const v = values({ notes: 'Two off first, then the balance.' });
  const text = Q.summaryText(v, Q.estimate(v, NOW), Q.reference(v, NOW));
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7E\n]*$/.test(text), 'found a character that mail clients mangle');
});

test('money and dates read the way people write them', () => {
  assert.equal(Q.money(0), '$0.00');
  assert.equal(Q.money(1234.5), '$1,234.50');
  assert.equal(Q.money(1234567.89), '$1,234,567.89');
  assert.equal(Q.formatDate(Date.parse('2026-01-05T00:00:00Z')), '5 Jan 2026');
  assert.equal(Q.formatDate(null), 'not set');
});
