'use strict';
/* Subscriptions service — M4c slice (FR-001…008 except live bank sync).
 * Personal subscriptions have roomId null; shared ones link exactly one room (FR-007).
 * Money in integer minor units. Status machine: ACTIVE -> PENDING_CONCIERGE -> CANCELLED,
 * plus direct ACTIVE -> CANCELLED on user confirmation.
 */
const {
  GetCommand, PutCommand, UpdateCommand, QueryCommand, TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { badRequest, forbidden, notFound } = require('./errors');
const { entityId, nowIso } = require('./ids');
const { newEvent, putEventItem } = require('./outbox');
const { requireRole } = require('./rooms');

function subEvent(tables, type, subId, payload) {
  return putEventItem(tables.outbox, newEvent(type, 'subscription', subId, payload));
}

async function createSubscription({ doc, tables }, { ownerId, provider, amountMinor, currency = 'INR', renewalDate }) {
  if (!provider || !provider.trim()) throw badRequest('bad-provider', 'provider required');
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw badRequest('bad-amount', 'amountMinor must be a positive integer');
  if (!renewalDate || Number.isNaN(Date.parse(renewalDate))) throw badRequest('bad-date', 'valid renewalDate required');
  // No null attributes: absent keys keep the sparse GSI clean and suit Local/real DynamoDB alike.
  const subscription = {
    subscriptionId: entityId('sb_'), ownerId, provider: provider.trim(),
    amountMinor, currency, renewalDate, status: 'ACTIVE',
    v: 1, createdAt: nowIso(), updatedAt: nowIso(),
  };
  await doc.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: tables.subscriptions, Item: subscription } },
      subEvent(tables, 'SubscriptionDetected', subscription.subscriptionId, { ownerId, provider }),
    ],
  }));
  return { subscription };
}

async function getSubscription({ doc, tables }, { requesterId, subscriptionId }) {
  const r = await doc.send(new GetCommand({ TableName: tables.subscriptions, Key: { subscriptionId } }));
  const s = r.Item;
  if (!s) throw notFound('subscription not found');
  if (s.ownerId !== requesterId) {
    if (!s.roomId) throw notFound('subscription not found');
    await requireRole(doc, tables, s.roomId, requesterId, ['OWNER', 'MEMBER']);
  }
  return { subscription: s };
}

async function listMySubscriptions({ doc, tables }, { userId }) {
  const q = await doc.send(new QueryCommand({
    TableName: tables.subscriptions, IndexName: 'gsi1-owner',
    KeyConditionExpression: 'ownerId = :u', ExpressionAttributeValues: { ':u': userId },
  }));
  return (q.Items || []).filter((s) => s.status === 'ACTIVE');
}

/* Link a personal subscription to a room (room owner only). One room max (FR-007). */
async function linkToRoom({ doc, tables }, { actorId, subscriptionId, roomId }) {
  await requireRole(doc, tables, roomId, actorId, ['OWNER']);
  const cur = await doc.send(new GetCommand({ TableName: tables.subscriptions, Key: { subscriptionId } }));
  if (!cur.Item) throw notFound('subscription not found');
  if (cur.Item.ownerId !== actorId) throw forbidden('only the subscription owner can share it');
  await doc.send(new UpdateCommand({
    TableName: tables.subscriptions, Key: { subscriptionId },
    UpdateExpression: 'SET roomId = :r, updatedAt = :u',
    ConditionExpression: 'attribute_not_exists(roomId) AND #st = :active',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':r': roomId, ':u': nowIso(), ':active': 'ACTIVE' },
  })).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') {
      throw badRequest('already-shared', 'subscription already linked or inactive');
    }
    throw err;
  });
  return { subscriptionId, roomId };
}

async function confirmCancelled({ doc, tables }, { requesterId, subscriptionId }) {
  const { subscription } = await getSubscription({ doc, tables }, { requesterId, subscriptionId });
  if (subscription.ownerId !== requesterId) throw forbidden('only the owner confirms cancellation');
  await doc.send(new UpdateCommand({
    TableName: tables.subscriptions, Key: { subscriptionId },
    UpdateExpression: 'SET #st = :c, updatedAt = :u',
    ConditionExpression: '#st IN (:a, :p)',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':c': 'CANCELLED', ':a': 'ACTIVE', ':p': 'PENDING_CONCIERGE', ':u': nowIso() },
  })).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') throw badRequest('bad-status', 'already cancelled');
    throw err;
  });
  await doc.send(new TransactWriteCommand({
    TransactItems: [subEvent(tables, 'CancellationCompleted', subscriptionId, { by: requesterId })],
  }));
  return { subscriptionId, status: 'CANCELLED' };
}

/* Subscriptions renewing within the window (ms). Personal-owner scan via GSI; room-shared
 * subscriptions surface through the same owner rows. Pure filter over owned rows. */
async function renewalsDue({ doc, tables }, { ownerId, withinMs = 72 * 3600 * 1000 }) {
  const subs = await listMySubscriptions({ doc, tables }, { userId: ownerId });
  const horizon = Date.now() + withinMs;
  return subs.filter((s) => Date.parse(s.renewalDate) <= horizon);
}

module.exports = {
  createSubscription, getSubscription, listMySubscriptions, linkToRoom, confirmCancelled, renewalsDue,
};
