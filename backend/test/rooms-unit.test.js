'use strict';
/* M4a unit tests: pure logic only, no database. Run: npm test */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { entityId, inviteToken, lockOwner } = require('../src/ids');
const { HttpError, goneFrozen } = require('../src/errors');
const { validateTransfer } = require('../src/rooms');
const { requireUser } = require('../src/auth');
const { newEvent } = require('../src/outbox');

test('invite tokens are 256-bit opaque and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const t = inviteToken();
    assert.equal(typeof t, 'string');
    assert.ok(t.length >= 43, `unexpected token length ${t.length}`);
    assert.ok(!t.includes('=') && !t.includes('+') && !t.includes('/'), 'must be base64url');
    assert.ok(!seen.has(t), 'duplicate token');
    seen.add(t);
  }
});

test('entity ids carry their prefix; lock owners are uuids', () => {
  assert.ok(entityId('rm_').startsWith('rm_'));
  assert.ok(entityId('ev_').startsWith('ev_'));
  assert.match(lockOwner(), /^[0-9a-f-]{36}$/);
});

test('validateTransfer decision matrix', () => {
  const room = { status: 'ACTIVE' };
  const owner = { role: 'OWNER', status: 'ACTIVE', workosUserId: 'u-owner' };
  const member = { role: 'MEMBER', status: 'ACTIVE', workosUserId: 'u-mem' };
  assert.equal(validateTransfer({ room, requester: owner, successor: member }), null);
  assert.equal(validateTransfer({ room: null, requester: owner, successor: member }), 'no-room');
  assert.equal(validateTransfer({ room: { status: 'FROZEN' }, requester: owner, successor: member }), 'frozen');
  assert.equal(validateTransfer({ room, requester: member, successor: member }), 'not-owner');
  assert.equal(validateTransfer({ room, requester: owner, successor: null }), 'bad-successor');
  assert.equal(validateTransfer({ room, requester: owner, successor: { ...member, status: 'REMOVED' } }), 'bad-successor');
  assert.equal(validateTransfer({ room, requester: owner, successor: owner }), 'bad-successor');
  assert.equal(validateTransfer({ room, requester: owner, successor: { ...owner, workosUserId: 'u-owner' } }), 'bad-successor');
  assert.equal(validateTransfer({ room, requester: owner, successor: { ...member, workosUserId: 'u-owner' } }), 'self');
});

test('frozen rooms surface as 409 room-frozen', () => {
  const err = goneFrozen();
  assert.ok(err instanceof HttpError);
  assert.equal(err.statusCode, 409);
  assert.equal(err.code, 'room-frozen');
});

test('requireUser fails closed without the test seam', () => {
  delete process.env.ALLOW_TEST_AUTH;
  assert.throws(() => requireUser({ headers: { 'x-test-user': 'u1' } }), (e) => e.statusCode === 501);
});

test('requireUser honors the test seam only with a user header', () => {
  process.env.ALLOW_TEST_AUTH = 'true';
  try {
    assert.equal(requireUser({ headers: { 'x-test-user': 'u1' } }).workosUserId, 'u1');
    assert.throws(() => requireUser({ headers: {} }), (e) => e.statusCode === 401);
  } finally {
    delete process.env.ALLOW_TEST_AUTH;
  }
});

test('outbox events start PENDING with identity', () => {
  const e = newEvent('RoomMemberJoined', 'room', 'rm_x', { userId: 'u1' });
  assert.equal(e.status, 'PENDING');
  assert.ok(e.eventId.startsWith('ev_'));
  assert.equal(e.aggregateId, 'rm_x');
});
