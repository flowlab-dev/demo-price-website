// What the form accepts, and what it says when it does not.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Q = require('../demo/assets/quote.js');

const NOW = new Date(2026, 8, 23, 9, 0, 0).getTime(); // Wednesday, on the visitor's own clock

function good(extra) {
  return Object.assign({
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
    neededBy: '',
    contactName: 'Dana Reyes',
    company: 'Reyes Fabrication',
    email: 'dana@example.com',
    notes: ''
  }, extra || {});
}

test('a complete RFQ passes', () => {
  const r = Q.validate(good(), NOW);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.values.partName, 'Mount bracket NG-2291');
  assert.equal(r.values.material.id, 'crs');
  assert.equal(r.values.thickness, 2);
  assert.equal(r.values.quantity, 50);
  assert.equal(r.values.neededBy, null);
});

test('an empty form names every field it needs', () => {
  const r = Q.validate({}, NOW);
  assert.equal(r.ok, false);
  for (const field of ['partName', 'thickness', 'length', 'width', 'quantity', 'contactName', 'email']) {
    assert.ok(r.errors[field], 'missing message for ' + field);
  }
  // Defaults that a shop can live with are not errors.
  assert.equal(r.errors.bends, undefined);
  assert.equal(r.errors.holes, undefined);
  assert.equal(r.errors.finish, undefined);
  assert.equal(r.errors.neededBy, undefined);
});

test('whitespace is tidied, not rejected', () => {
  const r = Q.validate(good({ partName: '  Mount   bracket  ', contactName: ' Dana   Reyes ' }), NOW);
  assert.equal(r.values.partName, 'Mount bracket');
  assert.equal(r.values.contactName, 'Dana Reyes');
});

test('thickness has to be a thickness we stock', () => {
  assert.match(Q.validate(good({ thickness: '2.3' }), NOW).errors.thickness, /We stock/);
  assert.match(Q.validate(good({ thickness: 'thick' }), NOW).errors.thickness, /number/);
  assert.equal(Q.validate(good({ material: 'ss304', thickness: '6.0' }), NOW).errors.thickness !== undefined, true,
    'stainless stops at 5 mm');
  assert.equal(Q.validate(good({ material: 'al5052', thickness: '0.8' }), NOW).errors.thickness !== undefined, true,
    'aluminium starts at 1 mm');
  assert.equal(Q.validate(good({ material: 'al5052', thickness: '6.0' }), NOW).ok, true);
});

test('a comma decimal is a decimal', () => {
  assert.equal(Q.validate(good({ thickness: '2,0' }), NOW).ok, true);
});

test('the part has to fit the bed', () => {
  assert.match(Q.validate(good({ length: '3001' }), NOW).errors.length, /bed/);
  assert.match(Q.validate(good({ width: '1501' }), NOW).errors.width, /bed/);
  assert.match(Q.validate(good({ width: '12' }), NOW).errors.width, /Smallest side/);
  assert.equal(Q.validate(good({ length: '3000', width: '1500' }), NOW).ok, true);
});

test('quantity is a whole number between one and two thousand', () => {
  assert.match(Q.validate(good({ quantity: '0' }), NOW).errors.quantity, /minimum/);
  assert.match(Q.validate(good({ quantity: '2.5' }), NOW).errors.quantity, /whole number/);
  assert.match(Q.validate(good({ quantity: '2001' }), NOW).errors.quantity, /quote by hand/);
  assert.equal(Q.validate(good({ quantity: '1' }), NOW).ok, true);
});

test('bends and holes default to none and refuse nonsense', () => {
  const blank = Q.validate(good({ bends: '', holes: '' }), NOW);
  assert.equal(blank.values.bends, 0);
  assert.equal(blank.values.holes, 0);
  assert.match(Q.validate(good({ bends: '-1' }), NOW).errors.bends, /negative/);
  assert.match(Q.validate(good({ bends: '21' }), NOW).errors.bends, /by hand/);
  assert.match(Q.validate(good({ holes: '401' }), NOW).errors.holes, /DXF/);
});

test('email is checked, but not lectured about', () => {
  assert.equal(Q.validateEmail('dana@example.com'), true);
  assert.equal(Q.validateEmail('dana.reyes+rfq@shop.co.uk'), true);
  assert.equal(Q.validateEmail('dana@localhost'), false);
  assert.equal(Q.validateEmail('dana at example.com'), false);
  assert.equal(Q.validateEmail(''), false);
  assert.match(Q.validate(good({ email: 'nope' }), NOW).errors.email, /@/);
});

test('a date in the past is caught, today is fine, empty is fine', () => {
  assert.match(Q.validate(good({ neededBy: '2026-09-22' }), NOW).errors.neededBy, /passed/);
  assert.equal(Q.validate(good({ neededBy: '2026-09-23' }), NOW).ok, true);
  assert.equal(Q.validate(good({ neededBy: '2026-13-01' }), NOW).errors.neededBy !== undefined, true);
  assert.equal(Q.validate(good({ neededBy: '2026-02-30' }), NOW).errors.neededBy !== undefined, true);
  assert.equal(Q.validate(good({ neededBy: '' }), NOW).values.neededBy, null);
});

test('long text is trimmed back with a reason', () => {
  assert.match(Q.validate(good({ partName: 'x'.repeat(61) }), NOW).errors.partName, /60/);
  assert.match(Q.validate(good({ notes: 'x'.repeat(601) }), NOW).errors.notes, /600/);
  assert.match(Q.validate(good({ company: 'x'.repeat(81) }), NOW).errors.company, /80/);
  assert.equal(Q.validate(good({ notes: 'x'.repeat(600) }), NOW).ok, true);
});

test('the first field to fix is the first one on the page', () => {
  const r = Q.validate({ material: 'crs', thickness: '2.0' }, NOW);
  assert.equal(Q.firstErrorField(r.errors), 'partName');
  const r2 = Q.validate(good({ email: 'nope', quantity: '0' }), NOW);
  assert.equal(Q.firstErrorField(r2.errors), 'quantity');
});

test('every message tells the person what to do, in plain words', () => {
  const r = Q.validate({ thickness: 'x', length: '4000', quantity: 'many', email: 'nope' }, NOW);
  for (const [field, message] of Object.entries(r.errors)) {
    assert.ok(message.length > 8, field + ' message is too short');
    assert.ok(/[.!?]$/.test(message), field + ' message should be a sentence');
    assert.ok(!/error|invalid|failed/i.test(message), field + ' message uses system words: ' + message);
  }
});
