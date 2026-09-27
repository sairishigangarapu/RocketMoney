'use strict';
/* WorkOS -> DynamoDB identity sync (ADR-010, ROOM-009/010). Verification uses the official
 * WorkOS SDK (constructEvent: signature + tolerance). Handler is idempotent on WorkOS event
 * ID and safe to retry; deletion never hard-deletes while domain rows reference the user.
 */
const { WorkOS } = require('@workos-inc/node');
const { GetCommand, PutCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { badRequest, unauthorized } = require('./errors');
const { nowIso } = require('./ids');
const { freezeRoom } = require('./rooms');

function workOS() {
  if (!process.env.WORKOS_API_KEY) throw new Error('WORKOS_API_KEY required for sync');
  return new WorkOS(process.env.WORKOS_API_KEY);
}

async function verifyEvent({ rawBody, sigHeader }) {
  const secret = process.env.WORKOS_WEBHOOK_SECRET;
  if (!secret) throw unauthorized('webhook secret not configured');
  return workOS().webhooks.constructEvent({ payload: rawBody, sigHeader, secret });
}

function idemKey(eventId) {
  return `wh:${eventId}`;
}

async function alreadyApplied(doc, tables, eventId) {
  const r = await doc.send(new GetCommand({
    TableName: tables.idempotency, Key: { key: idemKey(eventId) },
  }));
  return Boolean(r.Item);
}

async function markApplied(doc, tables, eventId) {
  await doc.send(new PutCommand({
    TableName: tables.idempotency,
    Item: { key: idemKey(eventId), resultRef: 'applied', expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
    ConditionExpression: 'attribute_not_exists(#k)',
    ExpressionAttributeNames: { '#k': 'key' },
  })).catch((err) => {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    const dup = new Error('duplicate webhook delivery');
    dup.code = 'DUPLICATE';
    throw dup;
  });
}

function profileFromEventData(data) {
  // Data arrives post-SDK-deserialization: camelCase (firstName/lastName), not snake_case.
  const d = data || {};
  const name = d.name || [d.firstName, d.lastName].filter(Boolean).join(' ') || d.email || d.id;
  return { workosUserId: d.id, email: d.email || null, name };
}

async function applyCreated(doc, tables, profile, ts) {
  const now = nowIso();
  await doc.send(new PutCommand({
    TableName: tables.users,
    Item: { ...profile, status: 'ACTIVE', v: 1, createdAt: ts || now, updatedAt: now, lastEventId: null },
    ConditionExpression: 'attribute_not_exists(workosUserId)',
  })).catch((err) => {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    // Race/redelivery: fall through to guarded update below.
  });
  await doc.send(new UpdateCommand({
    TableName: tables.users,
    Key: { workosUserId: profile.workosUserId },
    UpdateExpression: 'SET email = :e, #n = :n, updatedAt = :u, #st = :active',
    ConditionExpression: 'updatedAt < :u',
    ExpressionAttributeNames: { '#n': 'name', '#st': 'status' },
    ExpressionAttributeValues: { ':e': profile.email, ':n': profile.name, ':u': now, ':active': 'ACTIVE' },
  })).catch((err) => {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  });
}

async function applyUpdated(doc, tables, profile) {
  const now = nowIso();
  const r = await doc.send(new UpdateCommand({
    TableName: tables.users,
    Key: { workosUserId: profile.workosUserId },
    UpdateExpression: 'SET email = :e, #n = :n, updatedAt = :u',
    ConditionExpression: 'attribute_exists(workosUserId) AND updatedAt < :u',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':e': profile.email, ':n': profile.name, ':u': now },
    ReturnValues: 'ALL_NEW',
  })).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') return null; // unknown user or stale event
    throw err;
  });
  return r ? 'updated' : 'ignored-stale-or-unknown';
}

async function ownedRooms(doc, tables, userId) {
  const r = await doc.send(new QueryCommand({
    TableName: tables.rooms,
    IndexName: 'gsi1-owner',
    KeyConditionExpression: 'ownerId = :u',
    ExpressionAttributeValues: { ':u': userId },
  }));
  return r.Items || [];
}

async function applyLifecycle(doc, tables, profile, nextStatus) {
  const now = nowIso();
  await doc.send(new UpdateCommand({
    TableName: tables.users,
    Key: { workosUserId: profile.workosUserId },
    UpdateExpression: 'SET #st = :s, email = :e, #n = :n, updatedAt = :u',
    ConditionExpression: 'attribute_exists(workosUserId)',
    ExpressionAttributeNames: { '#st': 'status', '#n': 'name' },
    ExpressionAttributeValues: { ':s': nextStatus, ':e': profile.email, ':n': profile.name, ':u': now },
  })).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') return null;
    throw err;
  });
  // Transfer-or-freeze (ROOM-006): owned ACTIVE rooms with no successor are frozen, never deleted.
  const frozen = [];
  for (const room of await ownedRooms(doc, tables, profile.workosUserId)) {
    if (room.status !== 'ACTIVE') continue;
    // eslint-disable-next-line no-await-in-loop
    await freezeRoom({ doc, tables }, { roomId: room.roomId, reason: `owner-${nextStatus.toLowerCase()}` });
    frozen.push(room.roomId);
  }
  return { status: nextStatus, frozenRooms: frozen };
}

/* Entry point for the webhook route. Returns a small outcome object for logging/observability. */
async function handleWorkOSWebhook({ doc, tables }, { rawBody, sigHeader }) {
  let event;
  try {
    // eslint-disable-next-line no-await-in-loop
    event = await verifyEvent({ rawBody, sigHeader });
  } catch (err) {
    throw unauthorized(`invalid webhook signature: ${err.message}`);
  }
  // Official SDK shape: { id, event, data, createdAt, context } (verified against
  // @workos-inc/node constructEvent — type lives in `event`, not `type`).
  const eventId = event.id;
  const eventType = event.event;
  if (!event || !eventId || !eventType) throw badRequest('bad-event', 'malformed event');
  if (await alreadyApplied(doc, tables, eventId)) return { outcome: 'duplicate-ignored', eventId };
  const profile = profileFromEventData(event.data);
  if (!profile.workosUserId) throw badRequest('bad-event', 'event carries no user id');
  let result;
  switch (eventType) {
    case 'user.created':
      // eslint-disable-next-line no-await-in-loop
      await applyCreated(doc, tables, profile, event.createdAt);
      result = 'created';
      break;
    case 'user.updated':
      // eslint-disable-next-line no-await-in-loop
      result = await applyUpdated(doc, tables, profile);
      break;
    case 'user.deleted':
      // eslint-disable-next-line no-await-in-loop
      result = await applyLifecycle(doc, tables, profile, 'DELETED');
      break;
    case 'user.deactivated':
      // eslint-disable-next-line no-await-in-loop
      result = await applyLifecycle(doc, tables, profile, 'DEACTIVATED');
      break;
    default:
      return { outcome: 'ignored-type', eventId, type: eventType };
  }
  try {
    // eslint-disable-next-line no-await-in-loop
    await markApplied(doc, tables, eventId);
  } catch (err) {
    if (err.code === 'DUPLICATE') return { outcome: 'duplicate-ignored', eventId };
    throw err;
  }
  return { outcome: result, eventId, userId: profile.workosUserId };
}

module.exports = { handleWorkOSWebhook, verifyEvent };
