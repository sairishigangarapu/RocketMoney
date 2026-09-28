'use strict';
/* M4c unit tests: detector, CSV parsing, guides, aggregation. No database. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectRecurring } = require('../src/analysis');
const { parseCSV, normalizeMerchant } = require('../src/transactions');
const { cancellationGuide } = require('../src/notify');
const { aggregate, toCSV } = require('../src/reports');

function charge(merchant, date, amountMinor) {
  return { merchantNorm: normalizeMerchant(merchant), amountMinor, bookedAt: date };
}

test('detector flags monthly same-amount charges, ignores one-offs', () => {
  const txns = [
    charge('Netflix', '2026-06-05', 64900),
    charge('Netflix', '2026-07-05', 64900),
    charge('Netflix', '2026-08-06', 64900),
    charge('Corner Store', '2026-07-01', 12000),
    charge('Refund', '2026-07-02', -5000),
  ];
  const found = detectRecurring(txns);
  assert.equal(found.length, 1);
  assert.equal(found[0].merchant, 'netflix');
  assert.equal(found[0].monthlyMinor, 64900);
  assert.match(found[0].renewalDate, /2026-09-0/);
});

test('detector requires consecutive monthly cadence', () => {
  const txns = [
    charge('Gym', '2026-01-01', 200000),
    charge('Gym', '2026-06-01', 200000), // one-off gap, not monthly
  ];
  assert.equal(detectRecurring(txns).length, 0);
});

test('CSV parsing validates shape and normalizes', () => {
  const rows = parseCSV('date,merchant,amount\n2026-08-01,NETFLIX Inc.,649.00\n2026-08-02,Cafe,-120.50\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amountMinor, 64900);
  assert.equal(rows[1].amountMinor, -12050);
  assert.equal(normalizeMerchant('NETFLIX Inc.'), 'netflix inc');
  assert.throws(() => parseCSV('date,merchant\n2026-08-01,X\n'), (e) => e.code === 'bad-csv');
  assert.throws(() => parseCSV('date,merchant,amount\n2026-08-01,X,abc\n'), (e) => e.code === 'bad-csv');
});

test('guides: known provider valid, unknown explicit unsupported', () => {
  const g = cancellationGuide('Netflix');
  assert.equal(g.supported, true);
  assert.ok(g.portal && g.steps.length > 0);
  const u = cancellationGuide('Some Random SaaS');
  assert.equal(u.supported, false);
  assert.equal(u.portal, null);
  assert.deepEqual(u.steps, []);
});

test('aggregate CSV contains totals and no personal data', () => {
  const rows = aggregate([
    { provider: 'Netflix', amountMinor: 64900 },
    { provider: 'Netflix', amountMinor: 64900 },
    { provider: 'Spotify', amountMinor: 11900 },
  ]);
  assert.equal(rows[0].provider, 'Netflix');
  assert.equal(rows[0].count, 2);
  const csv = toCSV(rows);
  assert.match(csv, /provider,subscriptions,monthly_minor,monthly_rupees/);
  assert.ok(!csv.includes('@') && !csv.includes('u-'), 'CSV must carry no identity');
});
