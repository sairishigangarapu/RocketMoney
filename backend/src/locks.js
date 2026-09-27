'use strict';
/* DynamoDB lease locks (ADR-004, NFR-004). Acquire is conditional on absence/expiry;
 * release verifies holder ownership. Crash safety comes from expiry, fencing from the
 * version/condition checks writers add on top (see DYNAMODB-DESIGN.md §1 locks).
 */
const { PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { conflict } = require('./errors');
const { nowEpoch } = require('./ids');

const LEASES = { join: 10, expense: 15, transfer: 15, analysis: 30 };

async function acquireLock(doc, locksTable, lockKey, owner, leaseSec) {
  const expiry = nowEpoch() + leaseSec;
  try {
    await doc.send(new PutCommand({
      TableName: locksTable,
      Item: { lockKey, owner, expiry, v: 1 },
      ConditionExpression: 'attribute_not_exists(lockKey) OR expiry < :now',
      ExpressionAttributeValues: { ':now': nowEpoch() },
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      throw conflict('lock-contention', `lock ${lockKey} held; retry with backoff`);
    }
    throw err;
  }
  return { lockKey, owner, expiry };
}

async function releaseLock(doc, locksTable, lockKey, owner) {
  await doc.send(new DeleteCommand({
    TableName: locksTable,
    Key: { lockKey },
    ConditionExpression: '#o = :owner',
    ExpressionAttributeNames: { '#o': 'owner' },
    ExpressionAttributeValues: { ':owner': owner },
  })).catch((err) => {
    // Expired-and-reacquired locks must not be deleted by a stale holder.
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  });
}

async function withLock(doc, locksTable, lockKey, owner, leaseSec, fn) {
  const lock = await acquireLock(doc, locksTable, lockKey, owner, leaseSec);
  try {
    return await fn(lock);
  } finally {
    await releaseLock(doc, locksTable, lockKey, owner);
  }
}

module.exports = { LEASES, acquireLock, releaseLock, withLock };
