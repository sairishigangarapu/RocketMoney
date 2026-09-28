'use strict';
/* Outbox worker loop (NFR-003). pollOnce(): claim one due event -> dispatch by type ->
 * DONE. Dispatch failure returns the event to PENDING with backoff; after MAX_ATTEMPTS
 * it goes to DLQ for human inspection. Crash between claim and done leaves the row
 * CLAIMED; the lease-recovery rule (M6 ops: reset stale CLAIMED to PENDING) redrives it.
 */
const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { claimDueEvent, markDone } = require('./outbox');
const { sendNotification } = require('./notify');
const { nowEpoch, nowIso } = require('./ids');

const MAX_ATTEMPTS = 10;

function log(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', component: 'worker', ...entry }));
}

async function reschedule(doc, outboxTable, event, err) {
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  const attempts = (event.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await doc.send(new UpdateCommand({
      TableName: outboxTable, Key: { eventId: event.eventId },
      UpdateExpression: 'SET #s = :dlq, attempts = :a, lastError = :e',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':dlq': 'DLQ', ':a': attempts, ':e': String((err && err.message) || err).slice(0, 500) },
    }));
    log({ outcome: 'dlq', eventId: event.eventId, type: event.type, attempts });
    return 'dlq';
  }
  const backoffSec = Math.min(3600, 30 * 2 ** Math.min(attempts, 6));
  await doc.send(new UpdateCommand({
    TableName: outboxTable, Key: { eventId: event.eventId },
    UpdateExpression: 'SET #s = :pending, nextAttemptAt = :nxt, attempts = :a',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':nxt': nowEpoch() + backoffSec, ':a': attempts },
  }));
  log({ outcome: 'retry-scheduled', eventId: event.eventId, type: event.type, attempts, backoffSec });
  return 'retry';
}

async function dispatch(event) {
  const p = event.payload || {};
  switch (event.type) {
    case 'SubscriptionRenewalApproaching':
      return sendNotification({
        channel: 'webhook', toUserId: p.ownerId,
        subject: `${p.provider} renews ${p.renewalDate}`,
        body: `${p.provider} charges ${p.amountMinor} minor units on ${p.renewalDate}.`,
      });
    case 'RoomMemberJoined':
    case 'RoomMemberRemoved':
    case 'RoomMemberUpdated':
    case 'RoomFrozen':
    case 'RoomUnfrozen':
    case 'ExpenseCreated':
    case 'ExpenseUpdated':
    case 'SettlementRequested':
    case 'SettlementCompleted':
    case 'SubscriptionDetected':
    case 'CancellationRequested':
    case 'CancellationCompleted':
    case 'ReportRequested':
      log({ outcome: 'dispatched-log', eventId: event.eventId, type: event.type });
      return { delivered: 'log' };
    default:
      log({ outcome: 'unknown-type-done', eventId: event.eventId, type: event.type });
      return { delivered: 'log-unknown' };
  }
}

async function pollOnce({ doc, tables }, workerId) {
  const event = await claimDueEvent(doc, tables.outbox, workerId || `worker-${process.pid}`);
  if (!event) return null;
  try {
    const result = await dispatch(event);
    await markDone(doc, tables.outbox, event.eventId);
    return { eventId: event.eventId, type: event.type, result };
  } catch (err) {
    return { eventId: event.eventId, type: event.type, error: await reschedule(doc, tables.outbox, event, err) };
  }
}

/* Distinct owner ids across subscriptions (powers the opt-in daily scan). MVP scan is
 * acceptable: owner cardinality is small; revisit with a dedicated index if it grows. */
async function distinctOwners({ doc, tables }) {
  const owners = new Set();
  let key;
  do {
    // eslint-disable-next-line no-await-in-loop
    const s = await doc.send(new ScanCommand({
      TableName: tables.subscriptions, ProjectionExpression: 'ownerId', ExclusiveStartKey: key,
    }));
    for (const item of s.Items || []) owners.add(item.ownerId);
    key = s.LastEvaluatedKey;
  } while (key);
  return [...owners];
}

async function scanAllRenewals(ctx) {
  const { scanRenewals } = require('./notify');
  const owners = await distinctOwners(ctx);
  const out = { owners: owners.length, emitted: [] };
  for (const ownerId of owners) {
    // eslint-disable-next-line no-await-in-loop
    const r = await scanRenewals(ctx, { ownerId });
    out.emitted.push(...r.emitted);
  }
  log({ outcome: 'scan-all', owners: out.owners, emitted: out.emitted.length, at: nowIso() });
  return out;
}

module.exports = { pollOnce, dispatch, reschedule, scanAllRenewals, distinctOwners, MAX_ATTEMPTS };
