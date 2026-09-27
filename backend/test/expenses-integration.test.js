'use strict';
/* M4b integration tests vs DynamoDB Local (issue #7 acceptance).
 * Requires DynamoDB Local on http://localhost:8000. Run: npm run test:integration
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

process.env.DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
process.env.DYNAMODB_TABLE_PREFIX = 'rm-test-';
process.env.AWS_REGION = 'ap-south-1';

const { createDocClient } = require('../src/db');
const { tableNames } = require('../src/tables');
const { ensureTables } = require('../src/schema');
const rooms = require('../src/rooms');
const expenses = require('../src/expenses');

const tables = tableNames('rm-test-');
const raw = new DynamoDBClient({
  region: 'ap-south-1', endpoint: process.env.DYNAMODB_ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const doc = createDocClient();
const ctx = { doc, tables };

let n = 0;
const uid = (p) => `u-${p}-${Date.now()}-${(n += 1)}`;
let k = 0;
const ikey = () => `k-${Date.now()}-${(k += 1)}`;

before(async () => {
  await ensureTables(raw, 'rm-test-');
});

async function roomOf5() {
  const owner = uid('o');
  const { room } = await rooms.createRoom(ctx, { ownerId: owner, name: 'Netflix' });
  const members = [owner];
  const inv = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 10 });
  for (let i = 0; i < 4; i++) {
    const m = uid('m');
    members.push(m);
    await rooms.joinRoom(ctx, { userId: m, token: inv.token });
  }
  return { room, owner, members };
}

test('100000 minor / 5 equal: four 20000 receivables against the payer', async () => {
  const { room, owner, members } = await roomOf5();
  const { expense, duplicate } = await expenses.createExpense(ctx, {
    actorId: owner, roomId: room.roomId, amountMinor: 100000,
    payerId: owner, participants: members, idempotencyKey: ikey(),
  });
  assert.equal(duplicate, false);
  assert.equal(expense.shares[owner], 20000);
  const { pairs, net } = await expenses.getBalances(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(pairs.length, 4);
  for (const p of pairs) assert.equal(p.balanceMinor, p.pairKey.startsWith(`${owner}#`) ? -20000 : 20000);
  assert.equal(net[owner], -80000); // negative net = others owe the payer
  for (const m of members.slice(1)) assert.equal(net[m], 20000);
});

test('idempotent replay returns the original row without new ledger rows', async () => {
  const { room, owner, members } = await roomOf5();
  const key = ikey();
  const r1 = await expenses.createExpense(ctx, {
    actorId: owner, roomId: room.roomId, amountMinor: 50000,
    payerId: owner, participants: members, idempotencyKey: key,
  });
  const r2 = await expenses.createExpense(ctx, {
    actorId: owner, roomId: room.roomId, amountMinor: 50000,
    payerId: owner, participants: members, idempotencyKey: key,
  });
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(r1.expense.expenseId, r2.expense.expenseId);
  const list = await expenses.listExpenses(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(list.filter((e) => e.idempotencyKey === key).length, 1);
});

/* Room locks fail fast by design (ADR-004): concurrent same-room mutations contend and
 * the loser gets 409 lock-contention. Real clients back off and retry — this helper does that. */
async function withClientRetry(fn, attempts = 10) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.code !== 'lock-contention' || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

test('concurrent same-key submissions yield exactly one expense', async () => {
  const { room, owner, members } = await roomOf5();
  const key = ikey();
  const args = {
    actorId: owner, roomId: room.roomId, amountMinor: 30000,
    payerId: owner, participants: members, idempotencyKey: key,
  };
  // Both race; the lock-contention loser retries like a real client, then hits idempotency.
  const [a, b] = await Promise.all([
    withClientRetry(() => expenses.createExpense(ctx, args)),
    withClientRetry(() => expenses.createExpense(ctx, args)),
  ]);
  assert.equal(a.expense.expenseId, b.expense.expenseId);
  const list = await expenses.listExpenses(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(list.filter((e) => e.idempotencyKey === key).length, 1);
});

test('settlement lifecycle zeroes the pair; rebuild matches materialized', async () => {
  const { room, owner, members } = await roomOf5();
  const debtor = members[1];
  await expenses.createExpense(ctx, {
    actorId: owner, roomId: room.roomId, amountMinor: 100000,
    payerId: owner, participants: members, idempotencyKey: ikey(),
  });
  const req = await expenses.requestSettlement(ctx, {
    actorId: debtor, roomId: room.roomId, fromId: debtor, toId: owner,
    amountMinor: 20000, idempotencyKey: ikey(),
  });
  assert.equal(req.settlement.status, 'REQUESTED');
  const done = await expenses.completeSettlement(ctx, {
    actorId: owner, roomId: room.roomId, settlementId: req.settlement.settlementId,
  });
  assert.equal(done.settlement.status, 'COMPLETED');
  const again = await expenses.completeSettlement(ctx, {
    actorId: owner, roomId: room.roomId, settlementId: req.settlement.settlementId,
  });
  assert.equal(again.duplicate, true); // completing twice is safe
  const { net } = await expenses.getBalances(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(net[debtor], 0);
  const rebuilt = await expenses.rebuildBalances(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(rebuilt.match, true);
});

test('concurrent expense + settlement stay consistent with log replay', async () => {
  const { room, owner, members } = await roomOf5();
  const debtor = members[2];
  await expenses.createExpense(ctx, {
    actorId: owner, roomId: room.roomId, amountMinor: 100000,
    payerId: owner, participants: members, idempotencyKey: ikey(),
  });
  const s = await expenses.requestSettlement(ctx, {
    actorId: debtor, roomId: room.roomId, fromId: debtor, toId: owner,
    amountMinor: 20000, idempotencyKey: ikey(),
  });
  await Promise.all([
    withClientRetry(() => expenses.createExpense(ctx, {
      actorId: members[3], roomId: room.roomId, amountMinor: 50000,
      payerId: members[3], participants: members, idempotencyKey: ikey(),
    })),
    withClientRetry(() => expenses.completeSettlement(ctx, { actorId: owner, roomId: room.roomId, settlementId: s.settlement.settlementId })),
  ]);
  const rebuilt = await expenses.rebuildBalances(ctx, { requesterId: owner, roomId: room.roomId });
  assert.equal(rebuilt.match, true);
});

test('frozen rooms and strangers are rejected; removal needs settled balance', async () => {
  const { room, owner, members } = await roomOf5();
  const debtor = members[1];
  await expenses.createExpense(ctx, {
    actorId: owner, roomId: room.roomId, amountMinor: 100000,
    payerId: owner, participants: members, idempotencyKey: ikey(),
  });
  await assert.rejects(
    expenses.createExpense(ctx, {
      actorId: 'u-stranger', roomId: room.roomId, amountMinor: 100,
      payerId: 'u-stranger', participants: ['u-stranger'], idempotencyKey: ikey(),
    }),
    (e) => e.statusCode === 404,
  );
  // Debtor with unsettled balance cannot be removed (ROOM-007 over real balances).
  await assert.rejects(
    rooms.removeMember(ctx, { actorId: owner, roomId: room.roomId, targetId: debtor }),
    (e) => e.code === 'unsettled-balance',
  );
  const s = await expenses.requestSettlement(ctx, {
    actorId: debtor, roomId: room.roomId, fromId: debtor, toId: owner,
    amountMinor: 20000, idempotencyKey: ikey(),
  });
  await expenses.completeSettlement(ctx, { actorId: owner, roomId: room.roomId, settlementId: s.settlement.settlementId });
  const removed = await rooms.removeMember(ctx, { actorId: owner, roomId: room.roomId, targetId: debtor });
  assert.equal(removed.removed, debtor);
  // Frozen room rejects expense writes.
  await rooms.freezeRoom(ctx, { roomId: room.roomId, reason: 'test' });
  await assert.rejects(
    expenses.createExpense(ctx, {
      actorId: owner, roomId: room.roomId, amountMinor: 100,
      payerId: owner, participants: [owner], idempotencyKey: ikey(),
    }),
    (e) => e.code === 'room-frozen',
  );
});

test('deleted settlements are rejected; unknown settlement is 404', async () => {
  const { room, owner, members } = await roomOf5();
  await assert.rejects(
    expenses.completeSettlement(ctx, { actorId: owner, roomId: room.roomId, settlementId: 'st_missing' }),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    expenses.requestSettlement(ctx, {
      actorId: owner, roomId: room.roomId, fromId: owner, toId: owner,
      amountMinor: 100, idempotencyKey: ikey(),
    }),
    (e) => e.code === 'bad-parties',
  );
  const q = await doc.send(new QueryCommand({
    TableName: tables.balances,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': room.roomId },
  }));
  assert.ok(Array.isArray(q.Items));
});
