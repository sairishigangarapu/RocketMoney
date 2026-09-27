'use strict';
/* M4b unit tests: split math + ledger orientation. No database. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pairKey, equalSplit, obligationDelta } = require('../src/expenses');

test('equal split: 100000 minor / 5 members = 20000 each, sums exactly', () => {
  const ps = ['a', 'b', 'c', 'd', 'e'];
  const { shares, total } = equalSplit({ amountMinor: 100000, participants: ps, payerId: 'a' });
  for (const p of ps) assert.equal(shares.get(p), 20000);
  assert.equal([...shares.values()].reduce((x, y) => x + y, 0), total);
});

test('equal split: remainder paise go to the payer, deterministically', () => {
  const { shares } = equalSplit({ amountMinor: 100001, participants: ['a', 'b', 'c', 'd', 'e'], payerId: 'a' });
  assert.equal(shares.get('a'), 20001);
  for (const p of ['b', 'c', 'd', 'e']) assert.equal(shares.get(p), 20000);
});

test('equal split rejects bad input', () => {
  assert.throws(() => equalSplit({ amountMinor: 0, participants: ['a'], payerId: 'a' }), (e) => e.statusCode === 400);
  assert.throws(() => equalSplit({ amountMinor: -5, participants: ['a'], payerId: 'a' }), (e) => e.statusCode === 400);
  assert.throws(() => equalSplit({ amountMinor: 100, participants: [], payerId: 'a' }), (e) => e.statusCode === 400);
  assert.throws(() => equalSplit({ amountMinor: 100, participants: ['b'], payerId: 'a' }), (e) => e.code === 'bad-payer');
  assert.throws(() => equalSplit({ amountMinor: 2, participants: ['a', 'b', 'c'], payerId: 'a' }), (e) => e.code === 'bad-amount');
});

test('pairKey is canonical; self-pairs rejected', () => {
  assert.equal(pairKey('b', 'a'), 'a#b');
  assert.equal(pairKey('a', 'b'), 'a#b');
  assert.throws(() => pairKey('a', 'a'), (e) => e.code === 'bad-pair');
});

test('obligationDelta orients signs so B(first,second) = first owes second', () => {
  // b owes a 100, b > a lexicographically -> key a#b, delta -100 (a owes b less).
  assert.deepEqual(obligationDelta('b', 'a', 100), { key: 'a#b', delta: -100 });
  // a owes b 100 -> key a#b, delta +100.
  assert.deepEqual(obligationDelta('a', 'b', 100), { key: 'a#b', delta: 100 });
});
