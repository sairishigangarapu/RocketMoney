'use strict';
/* Expense / Split + Settlement service — M4b slice (EXP-001…007).
 * MVP: EQUAL split only. Money in integer minor units. Expense rows immutable.
 * Balance invariant: B(x,y) stored at pairKey "x#y" (x<y lexicographic) = net x owes y.
 * Every mutation runs under the room lock and persists
 * (domain row + balance updates + outbox row + idempotency row) in ONE TransactWrite.
 */
const {
  GetCommand, PutCommand, UpdateCommand, QueryCommand, TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { badRequest, notFound, conflict } = require('./errors');
const { entityId, lockOwner, nowIso, nowEpoch } = require('./ids');
const { LEASES, withLock } = require('./locks');
const { newEvent, putEventItem } = require('./outbox');
const { requireRole, netBalanceForUser } = require('./rooms');

const ROOM_KEY = (roomId) => `LOCK#ROOM#${roomId}`;

/* Canonical pair orientation: first < second lexicographically. */
function pairKey(a, b) {
  if (a === b) throw badRequest('bad-pair', 'pair requires two distinct users');
  return a < b ? `${a}#${b}` : `${b}#${a}`;
}

/* Equal split in minor units. Remainder paise go to the payer (deterministic, documented).
 * Returns { shares: Map(userId -> shareMinor), total } with sum(shares) === amountMinor.
 * Throws on bad input. Pure — unit-tested without a database. */
function equalSplit({ amountMinor, participants, payerId }) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw badRequest('bad-amount', 'amountMinor must be a positive integer');
  const uniq = [...new Set(participants || [])];
  if (uniq.length === 0) throw badRequest('bad-participants', 'at least one participant required');
  if (!uniq.includes(payerId)) throw badRequest('bad-payer', 'payer must be a participant (MVP rule)');
  const base = Math.floor(amountMinor / uniq.length);
  if (base <= 0) throw badRequest('bad-amount', 'amount too small to split among participants');
  const shares = new Map(uniq.map((u) => [u, base]));
  shares.set(payerId, shares.get(payerId) + (amountMinor - base * uniq.length));
  return { shares, total: amountMinor };
}

/* Fold one debtor->creditor obligation into balance-delta map: pairKey -> signed delta
 * where delta is added to B(first,second) = net first owes second. Pure. */
function obligationDelta(debtor, creditor, amountMinor) {
  const key = pairKey(debtor, creditor);
  const [first] = key.split('#');
  return { key, delta: debtor === first ? amountMinor : -amountMinor };
}

function outboxExpenseEvent(tables, type, roomId, payload) {
  return putEventItem(tables.outbox, newEvent(type, 'room', roomId, payload));
}

async function assertRoomWritable(doc, tables, roomId) {
  const r = await doc.send(new GetCommand({ TableName: tables.rooms, Key: { roomId } }));
  if (!r.Item) throw notFound('room not found');
  if (r.Item.status === 'FROZEN') {
    const e = new Error('room is frozen; writes rejected');
    e.statusCode = 409; e.code = 'room-frozen'; throw e;
  }
  return r.Item;
}

async function assertActiveMembers(doc, tables, roomId, userIds) {
  for (const u of userIds) {
    // eslint-disable-next-line no-await-in-loop
    const m = await doc.send(new GetCommand({
      TableName: tables.memberships, Key: { roomId, workosUserId: u },
    }));
    if (!m.Item || m.Item.status !== 'ACTIVE') throw badRequest('bad-member', `not an active member: ${u}`);
  }
}

async function findByIdemKey(doc, tables, table, idemKey) {
  const q = await doc.send(new QueryCommand({
    TableName: table, IndexName: 'gsi1-idem',
    KeyConditionExpression: 'idempotencyKey = :k',
    ExpressionAttributeValues: { ':k': idemKey },
    Limit: 1,
  }));
  return (q.Items || [])[0] || null;
}

async function createExpense({ doc, tables }, { actorId, roomId, amountMinor, payerId, participants, idempotencyKey }) {
  await requireRole(doc, tables, roomId, actorId, ['OWNER', 'MEMBER']);
  if (!idempotencyKey || typeof idempotencyKey !== 'string') throw badRequest('bad-key', 'idempotencyKey required');
  const { shares } = equalSplit({ amountMinor, participants, payerId });
  return withLock(doc, tables.locks, ROOM_KEY(roomId), lockOwner(), LEASES.expense, async () => {
    await assertRoomWritable(doc, tables, roomId);
    await assertActiveMembers(doc, tables, roomId, [...shares.keys()]);
    // Idempotent replay: same key returns the original expense, no new rows (EXP-005).
    const existing = await findByIdemKey(doc, tables, tables.expenses, idempotencyKey);
    if (existing) return { expense: existing, duplicate: true };
    const expenseId = entityId('ex_');
    const now = nowIso();
    const expense = {
      roomId, expenseId, amountMinor, currency: 'INR', payerId,
      participants: [...shares.keys()], method: 'EQUAL',
      shares: Object.fromEntries(shares), idempotencyKey, createdBy: actorId, createdAt: now,
    };
    // One TransactWrite: expense row + balance deltas + outbox + idempotency guard (EXP-003).
    const deltas = new Map();
    for (const [participant, share] of shares) {
      if (participant === payerId || share === 0) continue;
      const { key, delta } = obligationDelta(participant, payerId, share);
      deltas.set(key, (deltas.get(key) || 0) + delta);
    }
    const tx = [
      {
        Put: {
          TableName: tables.expenses, Item: expense,
          ConditionExpression: 'attribute_not_exists(roomId)',
        },
      },
      ...[...deltas].map(([pair, delta]) => ({
        Update: {
          TableName: tables.balances, Key: { roomId, pairKey: pair },
          UpdateExpression: 'ADD balanceMinor :d SET updatedAt = :u, v = if_not_exists(v, :z) + :one',
          ExpressionAttributeValues: { ':d': delta, ':u': now, ':z': 0, ':one': 1 },
        },
      })),
      outboxExpenseEvent(tables, 'ExpenseCreated', roomId, { expenseId, payerId, amountMinor }),
      {
        Put: {
          TableName: tables.idempotency,
          Item: { key: `op:${idempotencyKey}`, resultRef: expenseId, expiresAt: nowEpoch() + 7 * 86400 },
          ConditionExpression: 'attribute_not_exists(#k)',
          ExpressionAttributeNames: { '#k': 'key' },
        },
      },
    ];
    try {
      await doc.send(new TransactWriteCommand({ TransactItems: tx }));
    } catch (err) {
      if (err.name === 'TransactionCanceledException') {
        // Lost a race with an identical submission: return the winner's row (EXP-005).
        const winner = await findByIdemKey(doc, tables, tables.expenses, idempotencyKey);
        if (winner) return { expense: winner, duplicate: true };
      }
      throw err;
    }
    return { expense, duplicate: false };
  });
}

async function listExpenses({ doc, tables }, { requesterId, roomId }) {
  await requireRole(doc, tables, roomId, requesterId, ['OWNER', 'MEMBER']);
  const q = await doc.send(new QueryCommand({
    TableName: tables.expenses,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': roomId },
  }));
  return (q.Items || []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

async function getBalances({ doc, tables }, { requesterId, roomId }) {
  await requireRole(doc, tables, roomId, requesterId, ['OWNER', 'MEMBER']);
  const q = await doc.send(new QueryCommand({
    TableName: tables.balances,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': roomId },
  }));
  const pairs = (q.Items || []).map((r) => ({
    pairKey: r.pairKey, balanceMinor: Number(r.balanceMinor) || 0,
  }));
  // Per-member netting is presentation logic over materialized pairs (ADR-008).
  const net = {};
  for (const p of pairs) {
    const [first, second] = p.pairKey.split('#');
    net[first] = (net[first] || 0) + p.balanceMinor;
    net[second] = (net[second] || 0) - p.balanceMinor;
  }
  return { pairs, net };
}

/* Rebuild balances purely from the immutable log; must equal materialized rows (EXP-006). */
async function rebuildBalances({ doc, tables }, { requesterId, roomId }) {
  await requireRole(doc, tables, roomId, requesterId, ['OWNER', 'MEMBER']);
  const expenses = await listExpenses({ doc, tables }, { requesterId, roomId });
  const st = await doc.send(new QueryCommand({
    TableName: tables.settlements,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': roomId },
  }));
  const rebuilt = new Map();
  const apply = (debtor, creditor, amount) => {
    const { key, delta } = obligationDelta(debtor, creditor, amount);
    rebuilt.set(key, (rebuilt.get(key) || 0) + delta);
  };
  for (const e of expenses) {
    const shares = e.shares || {};
    for (const [participant, share] of Object.entries(shares)) {
      if (participant === e.payerId || share === 0) continue;
      apply(participant, e.payerId, Number(share));
    }
  }
  for (const s of st.Items || []) {
    if (s.status !== 'COMPLETED') continue;
    apply(s.fromId, s.toId, -Number(s.amountMinor)); // settlement cancels debt: negative obligation
  }
  const { pairs } = await getBalances({ doc, tables }, { requesterId, roomId });
  const materialized = new Map(pairs.map((p) => [p.pairKey, p.balanceMinor]));
  const keys = new Set([...rebuilt.keys(), ...materialized.keys()]);
  const mismatches = [...keys].filter((k) => (rebuilt.get(k) || 0) !== (materialized.get(k) || 0));
  return { match: mismatches.length === 0, mismatches, rebuilt: Object.fromEntries(rebuilt) };
}

async function requestSettlement({ doc, tables }, { actorId, roomId, fromId, toId, amountMinor, idempotencyKey }) {
  await requireRole(doc, tables, roomId, actorId, ['OWNER', 'MEMBER']);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw badRequest('bad-amount', 'amountMinor must be a positive integer');
  if (!fromId || !toId || fromId === toId) throw badRequest('bad-parties', 'distinct fromId/toId required');
  if (!idempotencyKey) throw badRequest('bad-key', 'idempotencyKey required');
  return withLock(doc, tables.locks, ROOM_KEY(roomId), lockOwner(), LEASES.expense, async () => {
    await assertRoomWritable(doc, tables, roomId);
    await assertActiveMembers(doc, tables, roomId, [fromId, toId]);
    const existing = await findByIdemKey(doc, tables, tables.settlements, idempotencyKey);
    if (existing) return { settlement: existing, duplicate: true };
    const settlement = {
      roomId, settlementId: entityId('st_'), fromId, toId, amountMinor,
      status: 'REQUESTED', idempotencyKey, createdBy: actorId, createdAt: nowIso(),
    };
    const tx = [
      { Put: { TableName: tables.settlements, Item: settlement, ConditionExpression: 'attribute_not_exists(roomId)' } },
      outboxExpenseEvent(tables, 'SettlementRequested', roomId, { settlementId: settlement.settlementId, fromId, toId, amountMinor }),
      {
        Put: {
          TableName: tables.idempotency,
          Item: { key: `op:${idempotencyKey}`, resultRef: settlement.settlementId, expiresAt: nowEpoch() + 7 * 86400 },
          ConditionExpression: 'attribute_not_exists(#k)',
          ExpressionAttributeNames: { '#k': 'key' },
        },
      },
    ];
    try {
      await doc.send(new TransactWriteCommand({ TransactItems: tx }));
    } catch (err) {
      if (err.name === 'TransactionCanceledException') {
        const winner = await findByIdemKey(doc, tables, tables.settlements, idempotencyKey);
        if (winner) return { settlement: winner, duplicate: true };
      }
      throw err;
    }
    return { settlement, duplicate: false };
  });
}

async function completeSettlement({ doc, tables }, { actorId, roomId, settlementId }) {
  await requireRole(doc, tables, roomId, actorId, ['OWNER', 'MEMBER']);
  return withLock(doc, tables.locks, ROOM_KEY(roomId), lockOwner(), LEASES.expense, async () => {
    await assertRoomWritable(doc, tables, roomId);
    const cur = await doc.send(new GetCommand({
      TableName: tables.settlements, Key: { roomId, settlementId },
    }));
    const s = cur.Item;
    if (!s) throw notFound('settlement not found');
    if (s.status === 'COMPLETED') return { settlement: s, duplicate: true };
    if (s.status !== 'REQUESTED') throw conflict('bad-status', `cannot complete from ${s.status}`);
    const now = nowIso();
    // Settlement D->C of amount A cancels debt: obligation D->C of -A.
    const { key, delta } = obligationDelta(s.fromId, s.toId, -Number(s.amountMinor));
    await doc.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.settlements, Key: { roomId, settlementId },
            UpdateExpression: 'SET #s = :done, completedAt = :now',
            ConditionExpression: '#s = :req',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':done': 'COMPLETED', ':req': 'REQUESTED', ':now': now },
          },
        },
        {
          Update: {
            TableName: tables.balances, Key: { roomId, pairKey: key },
            UpdateExpression: 'ADD balanceMinor :d SET updatedAt = :u, v = if_not_exists(v, :z) + :one',
            ExpressionAttributeValues: { ':d': delta, ':u': now, ':z': 0, ':one': 1 },
          },
        },
        outboxExpenseEvent(tables, 'SettlementCompleted', roomId, { settlementId }),
      ],
    }));
    const updated = await doc.send(new GetCommand({ TableName: tables.settlements, Key: { roomId, settlementId } }));
    return { settlement: updated.Item, duplicate: false };
  });
}

module.exports = {
  pairKey, equalSplit, obligationDelta,
  createExpense, listExpenses, getBalances, rebuildBalances,
  requestSettlement, completeSettlement, netBalanceForUser,
};
