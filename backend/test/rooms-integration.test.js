'use strict';
/* M4a integration tests vs DynamoDB Local (issue #6 acceptance).
 * Requires: DynamoDB Local on http://localhost:8000
 *   docker run -d -p 8000:8000 amazon/dynamodb-local   (or the 1.x jar)
 * Run: npm run test:integration
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { WorkOS } = require('@workos-inc/node');

process.env.DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
process.env.DYNAMODB_TABLE_PREFIX = 'rm-test-';
process.env.AWS_REGION = 'ap-south-1';
process.env.WORKOS_API_KEY = 'test-key';
process.env.WORKOS_WEBHOOK_SECRET = 'test-wh-secret';

const { createDocClient } = require('../src/db');
const { tableNames } = require('../src/tables');
const { ensureTables } = require('../src/schema');
const rooms = require('../src/rooms');
const { handleWorkOSWebhook } = require('../src/sync');
const { acquireLock, releaseLock } = require('../src/locks');
const { claimDueEvent, markDone } = require('../src/outbox');
const { lockOwner } = require('../src/ids');

const tables = tableNames('rm-test-');
const raw = new DynamoDBClient({
  region: 'ap-south-1', endpoint: process.env.DYNAMODB_ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const doc = createDocClient();
const ctx = { doc, tables };

let n = 0;
const uid = (p) => `u-${p}-${Date.now()}-${(n += 1)}`;

before(async () => {
  await ensureTables(raw, 'rm-test-');
});

async function makeRoom(owner, name = 'Netflix') {
  const { room } = await rooms.createRoom(ctx, { ownerId: owner, name });
  return room;
}

test('create room: owner membership, get, list', async () => {
  const owner = uid('o');
  const room = await makeRoom(owner);
  assert.equal(room.ownerId, owner);
  assert.equal(room.status, 'ACTIVE');
  const got = await rooms.getRoom(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(got.role, 'OWNER');
  const members = await rooms.listMembers(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(members.length, 1);
});

test('listRooms returns owned and joined rooms with roles; strangers see none', async () => {
  const owner = uid('o');
  const r1 = await makeRoom(owner, 'Owned');
  const r2 = await makeRoom(uid('other'), 'Joined');
  const inv = await rooms.generateInvite(ctx, { actorId: r2.ownerId, roomId: r2.roomId, maxUses: 2 });
  await rooms.joinRoom(ctx, { userId: owner, token: inv.token });
  const mine = await rooms.listRooms(ctx, { userId: owner });
  const byId = Object.fromEntries(mine.map((r) => [r.roomId, r.myRole]));
  assert.equal(byId[r1.roomId], 'OWNER');
  assert.equal(byId[r2.roomId], 'MEMBER');
  assert.deepEqual(await rooms.listRooms(ctx, { userId: uid('ghost') }), []);
});

test('authZ: non-member sees 404, member cannot invite (403)', async () => {
  const owner = uid('o');
  const stranger = uid('s');
  const room = await makeRoom(owner);
  await assert.rejects(rooms.getRoom(ctx, { requesterId: stranger, roomId: room.roomId }), (e) => e.statusCode === 404);
  const invite = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 5 });
  const member = uid('m');
  await rooms.joinRoom(ctx, { userId: member, token: invite.token });
  await assert.rejects(
    rooms.generateInvite(ctx, { actorId: member, roomId: room.roomId }),
    (e) => e.statusCode === 403,
  );
});

test('join is idempotent on double submit', async () => {
  const owner = uid('o');
  const room = await makeRoom(owner);
  const invite = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 3 });
  const member = uid('m');
  const r1 = await rooms.joinRoom(ctx, { userId: member, token: invite.token });
  const r2 = await rooms.joinRoom(ctx, { userId: member, token: invite.token });
  assert.equal(r1.alreadyMember, false);
  assert.equal(r2.alreadyMember, true);
  const members = await rooms.listMembers(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(members.filter((m) => m.workosUserId === member).length, 1);
});

test('concurrent joins on a single-use token: exactly one membership', async () => {
  const owner = uid('o');
  const room = await makeRoom(owner);
  const invite = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 1 });
  const a = uid('a');
  const b = uid('b');
  const results = await Promise.allSettled([
    rooms.joinRoom(ctx, { userId: a, token: invite.token }),
    rooms.joinRoom(ctx, { userId: b, token: invite.token }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  const members = await rooms.listMembers(ctx, { requesterId: owner, roomId: room.roomId });
  const joined = members.filter((m) => m.role === 'MEMBER');
  assert.equal(joined.length, 1);
});

test('invalid/expired/revoked tokens share one error shape', async () => {
  const owner = uid('o');
  const room = await makeRoom(owner);
  for (const token of ['bogus']) {
    await assert.rejects(rooms.joinRoom(ctx, { userId: uid('x'), token }), (e) => e.statusCode === 404);
  }
  await assert.rejects(rooms.joinRoom(ctx, { userId: uid('x'), token: '' }), (e) => e.statusCode === 400);
  const inv = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 1, ttlSec: 3600 });
  await rooms.revokeInvite(ctx, { actorId: owner, roomId: room.roomId, token: inv.token });
  await assert.rejects(rooms.joinRoom(ctx, { userId: uid('x'), token: inv.token }), (e) => e.statusCode === 404);
  const exp = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 1, ttlSec: -1 });
  await assert.rejects(rooms.joinRoom(ctx, { userId: uid('x'), token: exp.token }), (e) => e.statusCode === 404);
});

test('transfer: rejected without successor, by non-owner; success flips roles', async () => {
  const owner = uid('o');
  const room = await makeRoom(owner);
  const member = uid('m');
  const inv = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 2 });
  await rooms.joinRoom(ctx, { userId: member, token: inv.token });
  await assert.rejects(
    rooms.transferOwnership(ctx, { actorId: owner, roomId: room.roomId, successorId: '' }),
    (e) => e.statusCode === 400,
  );
  await assert.rejects(
    rooms.transferOwnership(ctx, { actorId: member, roomId: room.roomId, successorId: member }),
    (e) => e.statusCode === 400,
  );
  const out = await rooms.transferOwnership(ctx, { actorId: owner, roomId: room.roomId, successorId: member });
  assert.equal(out.owner, member);
  // Old owner lost owner caps; new owner has them.
  await assert.rejects(
    rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId }),
    (e) => e.statusCode === 403,
  );
  const inv2 = await rooms.generateInvite(ctx, { actorId: member, roomId: room.roomId, maxUses: 1 });
  assert.ok(inv2.token);
});

test('removeMember: owner-only, never the owner, never with balance', async () => {
  const owner = uid('o');
  const room = await makeRoom(owner);
  const inv = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 3 });
  const m1 = uid('m1');
  const m2 = uid('m2');
  await rooms.joinRoom(ctx, { userId: m1, token: inv.token });
  await rooms.joinRoom(ctx, { userId: m2, token: inv.token });
  await assert.rejects(
    rooms.removeMember(ctx, { actorId: m1, roomId: room.roomId, targetId: m2 }),
    (e) => e.statusCode === 403,
  );
  await assert.rejects(
    rooms.removeMember(ctx, { actorId: owner, roomId: room.roomId, targetId: owner }),
    (e) => e.statusCode === 400,
  );
  const out = await rooms.removeMember(ctx, { actorId: owner, roomId: room.roomId, targetId: m1 });
  assert.equal(out.removed, m1);
  await assert.rejects(rooms.getRoom(ctx, { requesterId: m1, roomId: room.roomId }), (e) => e.statusCode === 404);
});

test('freeze blocks writes; member claim unfreezes with ownership', async () => {
  const owner = uid('o');
  const room = await makeRoom(owner);
  const inv = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 2 });
  const member = uid('m');
  await rooms.joinRoom(ctx, { userId: member, token: inv.token });
  await rooms.freezeRoom(ctx, { roomId: room.roomId, reason: 'test' });
  // Invite creation itself is blocked on frozen rooms:
  await assert.rejects(
    rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId }),
    (e) => e.code === 'room-frozen',
  );
  await assert.rejects(
    rooms.transferOwnership(ctx, { actorId: owner, roomId: room.roomId, successorId: member }),
    (e) => e.code === 'room-frozen',
  );
  const claimed = await rooms.claimFrozenRoom(ctx, { userId: member, roomId: room.roomId });
  assert.equal(claimed.owner, member);
  const again = await rooms.generateInvite(ctx, { actorId: member, roomId: room.roomId, maxUses: 1 });
  assert.ok(again.token);
});

test('locks: contention fails fast, release allows re-acquire', async () => {
  const key = `LOCK#TEST#${Date.now()}`;
  const a = lockOwner();
  await acquireLock(doc, tables.locks, key, a, 30);
  await assert.rejects(acquireLock(doc, tables.locks, key, lockOwner(), 30), (e) => e.code === 'lock-contention');
  await releaseLock(doc, tables.locks, key, a);
  await acquireLock(doc, tables.locks, key, lockOwner(), 30);
  await releaseLock(doc, tables.locks, key, 'wrong-owner'); // stale holder must not delete
  const still = await acquireLock(doc, tables.locks, key, lockOwner(), 30).catch((e) => e);
  assert.ok(still.code === 'lock-contention', 'lock must survive wrong-owner release');
});

test('outbox: room create emits claimable event; claim is single-winner', async () => {
  const owner = uid('o');
  const room = await makeRoom(owner, 'OutboxRoom');
  // GSI replication is eventually consistent (including DynamoDB Local): poll like a worker.
  // gsi1-due is KEYS_ONLY by design: resolve candidate eventIds to full base rows,
  // exactly as the production worker does after claiming.
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  let found = null;
  for (let i = 0; i < 50 && !found; i++) {
    const q = await doc.send(new QueryCommand({
      TableName: tables.outbox, IndexName: 'gsi1-due',
      KeyConditionExpression: '#s = :p', ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':p': 'PENDING' },
    }));
    for (const cand of q.Items || []) {
      const full = await doc.send(new GetCommand({ TableName: tables.outbox, Key: { eventId: cand.eventId } }));
      if (full.Item && full.Item.aggregateId === room.roomId && full.Item.type === 'RoomMemberJoined') {
        found = full.Item;
        break;
      }
    }
    if (!found) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(found, 'expected RoomMemberJoined PENDING event for the room');
  const w1 = `worker-1-${Date.now()}`;
  const w2 = `worker-2-${Date.now()}`;
  const [c1, c2] = await Promise.all([
    claimDueEvent(doc, tables.outbox, w1), claimDueEvent(doc, tables.outbox, w2),
  ]);
  const claimed = [c1, c2].filter(Boolean);
  assert.ok(claimed.length >= 1);
  assert.ok(new Set(claimed.map((c) => c.eventId)).size === claimed.length, 'no double-claim of one event');
  for (const c of claimed) await markDone(doc, tables.outbox, c.eventId);
});

// ---- WorkOS sync end-to-end (ROOM-009/010) with SDK-generated signatures ----
const wos = new WorkOS('test-key');
const SECRET = 'test-wh-secret';
async function signedEvent(type, userData, eventId) {
  // Real WorkOS wire shape: the event name travels in `event` (not `type`).
  const payload = JSON.stringify({
    id: eventId, event: type, created_at: new Date().toISOString(), data: userData,
  });
  const ts = Date.now();
  const sig = await wos.webhooks.computeSignature(ts, payload, SECRET);
  return { rawBody: payload, sigHeader: `t=${ts},v1=${sig}` };
}

test('sync: created -> updated -> duplicate ignored', async () => {
  const wid = `w_${Date.now()}_1`;
  const user = { id: wid, email: 'a@example.com', first_name: 'A', last_name: 'U' };
  const r1 = await handleWorkOSWebhook(ctx, await signedEvent('user.created', user, `evt-${wid}-c`));
  assert.equal(r1.outcome, 'created');
  const r2 = await handleWorkOSWebhook(ctx, await signedEvent('user.updated', { ...user, first_name: 'B' }, `evt-${wid}-u`));
  assert.equal(r2.outcome, 'updated');
  const r3 = await handleWorkOSWebhook(ctx, await signedEvent('user.created', user, `evt-${wid}-c`));
  assert.equal(r3.outcome, 'duplicate-ignored');
});

test('sync: bad signature rejected without state change', async () => {
  const wid = `w_${Date.now()}_9`;
  const payload = JSON.stringify({ id: `evt-${wid}`, type: 'user.created', data: { id: wid } });
  await assert.rejects(
    handleWorkOSWebhook(ctx, { rawBody: payload, sigHeader: 't=1,v1=bogus' }),
    (e) => e.statusCode === 401,
  );
});

test('sync: owner deleted -> DELETED + room frozen, member can claim', async () => {
  const wid = `w_${Date.now()}_d`;
  const owner = wid;
  await handleWorkOSWebhook(ctx, await signedEvent('user.created', { id: wid, email: 'o@example.com' }, `evt-${wid}-c`));
  const room = await makeRoom(owner, 'Doomed');
  const mem = uid('m');
  const inv = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 2 });
  await rooms.joinRoom(ctx, { userId: mem, token: inv.token });
  const out = await handleWorkOSWebhook(ctx, await signedEvent('user.deleted', { id: wid }, `evt-${wid}-d`));
  assert.deepEqual(out.outcome, { status: 'DELETED', frozenRooms: [room.roomId] });
  await assert.rejects(
    rooms.generateInvite(ctx, { actorId: mem, roomId: room.roomId }),
    (e) => e.code === 'room-frozen' || e.statusCode === 403,
  );
  const claimed = await rooms.claimFrozenRoom(ctx, { userId: mem, roomId: room.roomId });
  assert.equal(claimed.owner, mem);
});
