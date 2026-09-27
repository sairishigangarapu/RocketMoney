'use strict';
/* Transactional outbox helpers (ADR-005). appendEvent() builds a TransactWrite item so
 * callers persist domain mutation + outbox row atomically. Workers claim via conditional
 * status flip; duplicate delivery is normal — consumers dedupe on eventId (NFR-003).
 */
const { UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { entityId, nowIso, nowEpoch } = require('./ids');

function newEvent(type, aggregateType, aggregateId, payload = {}) {
  return {
    eventId: entityId('ev_'),
    type,
    aggregateType,
    aggregateId,
    payload,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: nowEpoch(),
    createdAt: nowIso(),
  };
}

function putEventItem(outboxTable, event) {
  return { Put: { TableName: outboxTable, Item: event } };
}

async function claimDueEvent(doc, outboxTable, workerId, now = nowEpoch()) {
  const due = await doc.send(new QueryCommand({
    TableName: outboxTable,
    IndexName: 'gsi1-due',
    KeyConditionExpression: '#s = :pending AND nextAttemptAt <= :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':now': now },
    Limit: 1,
  }));
  const row = (due.Items || [])[0];
  if (!row) return null;
  try {
    // ReturnValues ALL_NEW yields the FULL base-table item (GSI is KEYS_ONLY by design),
    // so the worker can dispatch without a second read.
    const data = await doc.send(new UpdateCommand({
      TableName: outboxTable,
      Key: { eventId: row.eventId },
      UpdateExpression: 'SET #s = :claimed, #o = :owner, attempts = attempts + :one',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status', '#o': 'owner' },
      ExpressionAttributeValues: { ':claimed': 'CLAIMED', ':pending': 'PENDING', ':owner': workerId, ':one': 1 },
      ReturnValues: 'ALL_NEW',
    }));
    return data.Attributes;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return null; // lost the race, honestly
    throw err;
  }
}

async function markDone(doc, outboxTable, eventId) {
  await doc.send(new UpdateCommand({
    TableName: outboxTable,
    Key: { eventId },
    UpdateExpression: 'SET #s = :done',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':done': 'DONE' },
  }));
}

module.exports = { newEvent, putEventItem, claimDueEvent, markDone };
