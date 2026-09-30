// The arithmetic behind the number a buyer sees.

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
    finish: 'mill',
    tolerance: 'standard',
    contactName: 'Dana Reyes',
    email: 'dana@example.com'
  }, extra || {}), NOW);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.values;
}

test('the bracket in the hero prices where a shop would put it', () => {
  const e = Q.estimate(values(), NOW);
  assert.ok(e.perPart > 5 && e.perPart < 20, 'per part was ' + e.perPart);
  assert.ok(e.low < e.total && e.total < e.high);
  assert.equal(e.low, Math.round(e.total * 0.88 * 100) / 100);
  assert.equal(e.high, Math.round(e.total * 1.12 * 100) / 100);
});

test('the breakdown adds up to the cost, and the cost carries one margin', () => {
  const e = Q.estimate(values(), NOW);
  const parts = Object.values(e.breakdown).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(parts - e.cost) < 0.05, parts + ' vs ' + e.cost);
  assert.ok(Math.abs(e.total - e.cost * 1.32) < 0.05);
});

test('setup is spread, so more parts cost less each and more in total', () => {
  const runs = ['1', '10', '50', '500', '2000'].map((q) => Q.estimate(values({ quantity: q }), NOW));
  for (let i = 1; i < runs.length; i += 1) {
    assert.ok(runs[i].perPart < runs[i - 1].perPart,
      'per part should fall from ' + runs[i - 1].quantity + ' to ' + runs[i].quantity);
    assert.ok(runs[i].total > runs[i - 1].total,
      'the bill should still grow from ' + runs[i - 1].quantity + ' to ' + runs[i].quantity);
  }
  // Ten times the parts for well under ten times the money is the whole point.
  assert.ok(runs[2].total < runs[1].total * 6);
});

test('a one-off lands on the job minimum, and the range does not dip under it', () => {
  const e = Q.estimate(values({ quantity: '1', bends: '0', holes: '0', length: '120', width: '80' }), NOW);
  assert.equal(e.belowMinimum, true);
  assert.equal(e.total, Q.SHOP.minimumJob);
  // A range starting below the minimum would quote a price we just refused.
  assert.equal(e.low, Q.SHOP.minimumJob);
  assert.equal(e.high, Q.SHOP.minimumJob);
  assert.equal(Q.priceRange(e), '$150.00', 'one figure, not a range, when it is the floor');
});

test('stainless costs more than mild steel, aluminium weighs less', () => {
  const steel = Q.estimate(values(), NOW);
  const stainless = Q.estimate(values({ material: 'ss304' }), NOW);
  const aluminium = Q.estimate(values({ material: 'al5052' }), NOW);
  assert.ok(stainless.total > steel.total, 'stainless should cost more');
  assert.ok(stainless.laserMinutesPerPart > steel.laserMinutesPerPart, 'stainless cuts slower');
  assert.ok(aluminium.massKgPerPart < steel.massKgPerPart, 'aluminium is lighter');
});

test('thicker plate cuts slower and weighs more', () => {
  const thin = Q.estimate(values({ thickness: '1.0' }), NOW);
  const thick = Q.estimate(values({ thickness: '5.0' }), NOW);
  // Handling and piercing are the same either way, so the cut itself is what stretches.
  const fixed = Q.SHOP.loadMinutesPerPart + 6 * (Q.SHOP.pierceSeconds / 60);
  assert.ok((thick.laserMinutesPerPart - fixed) > (thin.laserMinutesPerPart - fixed) * 3.5);
  assert.ok(thick.massKgPerPart > thin.massKgPerPart * 4.5);
  assert.ok(thick.total > thin.total);
});

test('feed rate is interpolated between the points we actually run', () => {
  const crs = Q.MATERIALS.crs;
  assert.equal(Q.feedRate(crs, 0.8), 9200);
  assert.equal(Q.feedRate(crs, 6.0), 1600);
  assert.equal(Q.feedRate(crs, 0.4), 9200, 'below the table we hold the fastest rate');
  assert.equal(Q.feedRate(crs, 9), 1600, 'above the table we hold the slowest');
  const mid = Q.feedRate(crs, 2.5);
  assert.ok(mid < 6100 && mid > 4200, 'between 2 and 3 mm, got ' + mid);
});

test('bends cost brake time and setup, flat parts skip both', () => {
  const flat = Q.estimate(values({ bends: '0' }), NOW);
  const bent = Q.estimate(values({ bends: '4' }), NOW);
  assert.equal(flat.breakdown.forming, 0);
  assert.ok(bent.breakdown.forming > 0);
  assert.equal(bent.setupMinutes - flat.setupMinutes, 4 * Q.SHOP.brakeSetupMinutes);
});

test('holes add cut length and pierces', () => {
  const plain = Q.estimate(values({ holes: '0' }), NOW);
  const punched = Q.estimate(values({ holes: '40' }), NOW);
  assert.equal(plain.cutLengthMm, 2 * (390 + 220));
  assert.equal(punched.cutLengthMm, plain.cutLengthMm + 40 * 28);
  assert.ok(punched.laserMinutesPerPart > plain.laserMinutesPerPart);
});

test('tight tolerance costs forming time, inspection time and a day', () => {
  const standard = Q.estimate(values(), NOW);
  const tight = Q.estimate(values({ tolerance: 'tight' }), NOW);
  assert.ok(tight.breakdown.forming > standard.breakdown.forming);
  assert.ok(tight.breakdown.inspection > standard.breakdown.inspection);
  assert.equal(tight.leadDays, standard.leadDays + 1);
});

test('finishing carries a lot minimum on small runs', () => {
  const small = Q.estimate(values({ quantity: '5', finish: 'powder' }), NOW);
  const large = Q.estimate(values({ quantity: '200', finish: 'powder' }), NOW);
  assert.equal(small.breakdown.finishing, Q.FINISHES.powder.lotMinimum);
  assert.equal(large.breakdown.finishing, 200 * Q.FINISHES.powder.perPart);
  assert.equal(Q.estimate(values({ finish: 'mill' }), NOW).breakdown.finishing, 0);
});

test('lead time grows with finishing and with big runs', () => {
  assert.equal(Q.estimate(values(), NOW).leadDays, 6);
  assert.equal(Q.estimate(values({ finish: 'powder' }), NOW).leadDays, 8);
  assert.equal(Q.estimate(values({ quantity: '300' }), NOW).leadDays, 8);
  assert.equal(Q.estimate(values({ quantity: '1500' }), NOW).leadDays, 10);
  assert.equal(Q.estimate(values({ quantity: '1500', finish: 'zinc', tolerance: 'tight' }), NOW).leadDays, 13);
});

test('business days skip the weekend', () => {
  // Wed 23 Sep 2026 + 6 business days = Thu 1 Oct 2026
  const e = Q.estimate(values(), NOW);
  assert.equal(new Date(e.readyBy).toISOString().slice(0, 10), '2026-10-01');
  assert.equal(Q.businessDaysBetween(NOW, Date.parse('2026-09-28T00:00:00Z')), 3);
  assert.equal(Q.businessDaysBetween(NOW, NOW), 0);
});

test('an early date turns into a rush, with the shortfall named', () => {
  const calm = Q.estimate(values({ neededBy: '2026-10-20' }), NOW);
  assert.equal(calm.rush, false);

  const rushed = Q.estimate(values({ neededBy: '2026-09-28' }), NOW); // a Monday, 3 business days out
  assert.equal(rushed.rush, true);
  assert.equal(rushed.rushDaysShort, 3);
  assert.ok(Math.abs(rushed.total - calm.total * 1.25) < 0.05, 'rush is 25 percent');
});

test('the same numbers always give the same answer', () => {
  const a = Q.estimate(values(), NOW);
  const b = Q.estimate(values(), NOW);
  assert.deepEqual(a, b);
});

test('today is the visitor\'s today, whatever the clock says in Greenwich', () => {
  // 23:30 local on 22 Sep is still 22 Sep for the person picking a date,
  // even where that moment is already 23 Sep in UTC.
  const lateEvening = new Date(2026, 8, 22, 23, 30, 0).getTime();
  assert.equal(Q.dayKey(lateEvening), Date.UTC(2026, 8, 22));
  const r = Q.validate({
    partName: 'Bracket', material: 'crs', thickness: '2.0', length: '390', width: '220',
    quantity: '10', contactName: 'Dana Reyes', email: 'dana@example.com', neededBy: '2026-09-22'
  }, lateEvening);
  assert.equal(r.errors.neededBy, undefined, 'today should still be bookable at 23:30');
});

test('a part only has room for so many features and bends', () => {
  const tiny = { partName: 'Tab', material: 'crs', thickness: '2.0', length: '20', width: '20',
    quantity: '10', bends: '20', holes: '400', contactName: 'Dana Reyes', email: 'dana@example.com' };
  const r = Q.validate(tiny, NOW);
  assert.equal(r.ok, false);
  assert.match(r.errors.holes, /room for about 4 features/);
  assert.match(r.errors.bends, /around 1/);
  // The same counts are fine on a part with room for them.
  const roomy = Q.validate(Object.assign({}, tiny, { length: '600', width: '600', bends: '20', holes: '390' }), NOW);
  assert.equal(roomy.ok, true, JSON.stringify(roomy.errors));
});

test('a job too big for a web page says so instead of quoting a million dollars quietly', () => {
  const huge = Q.estimate(values({ thickness: '6.0', length: '3000', width: '1500', quantity: '2000', bends: '0', holes: '0' }), NOW);
  assert.equal(huge.overCeiling, true);
  assert.ok(huge.total > Q.SHOP.quoteByHandOver);
  assert.equal(Q.estimate(values(), NOW).overCeiling, false);
});

test('every number that reaches the page is a finite number', () => {
  const corners = [
    { length: '20', width: '20', quantity: '1', bends: '0', holes: '0', thickness: '0.8' },
    { length: '3000', width: '1500', quantity: '2000', bends: '20', holes: '400', thickness: '6.0' },
    { length: '3000', width: '20', quantity: '1', bends: '1', holes: '4', thickness: '1.0' },
  ];
  for (const corner of corners) {
    const e = Q.estimate(values(Object.assign({ finish: 'zinc', tolerance: 'tight' }, corner)), NOW);
    for (const [key, value] of Object.entries(e)) {
      if (typeof value !== 'number') continue;
      assert.ok(Number.isFinite(value), key + ' came back as ' + value + ' for ' + JSON.stringify(corner));
      assert.ok(value >= 0, key + ' went negative for ' + JSON.stringify(corner));
    }
    assert.ok(e.low <= e.high);
  }
});

test('a date exactly on the lead time is not a rush', () => {
  const onTime = Q.estimate(values(), NOW);
  const ready = new Date(onTime.readyBy).toISOString().slice(0, 10);
  const same = Q.estimate(values({ neededBy: ready }), NOW);
  assert.equal(same.rush, false, 'the day we would be ready is not late');
  assert.equal(same.total, onTime.total);
});
