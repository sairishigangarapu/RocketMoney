'use strict';
/* Table schemas for ensureTables() (tests, local dev, future CI). PAY_PER_REQUEST in MVP
 * (DYNAMODB-DESIGN.md: on-demand until measured load). Mirrors the frozen M3 design.
 */
const { CreateTableCommand, ListTablesCommand } = require('@aws-sdk/client-dynamodb');

function key(name, type) {
  return { AttributeName: name, KeyType: type };
}
function attr(name, type) {
  return { AttributeName: name, AttributeType: type };
}
const PAY = { BillingMode: 'PAY_PER_REQUEST' };

function definitions(prefix) {
  const T = (t) => `${prefix}${t}`;
  return [
    {
      TableName: T('users'),
      KeySchema: [key('workosUserId', 'HASH')],
      AttributeDefinitions: [attr('workosUserId', 'S')],
      ...PAY,
    },
    {
      TableName: T('rooms'),
      KeySchema: [key('roomId', 'HASH')],
      AttributeDefinitions: [attr('roomId', 'S'), attr('ownerId', 'S')],
      GlobalSecondaryIndexes: [{
        IndexName: 'gsi1-owner', KeySchema: [key('ownerId', 'HASH'), key('roomId', 'RANGE')],
        Projection: { ProjectionType: 'ALL' },
      }],
      ...PAY,
    },
    {
      TableName: T('memberships'),
      KeySchema: [key('roomId', 'HASH'), key('workosUserId', 'RANGE')],
      AttributeDefinitions: [attr('roomId', 'S'), attr('workosUserId', 'S')],
      GlobalSecondaryIndexes: [{
        IndexName: 'gsi1-user', KeySchema: [key('workosUserId', 'HASH'), key('roomId', 'RANGE')],
        Projection: { ProjectionType: 'ALL' },
      }],
      ...PAY,
    },
    {
      TableName: T('subscriptions'),
      KeySchema: [key('subscriptionId', 'HASH')],
      AttributeDefinitions: [attr('subscriptionId', 'S'), attr('ownerId', 'S'), attr('roomId', 'S')],
      GlobalSecondaryIndexes: [
        { IndexName: 'gsi1-owner', KeySchema: [key('ownerId', 'HASH'), key('subscriptionId', 'RANGE')], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'gsi2-room', KeySchema: [key('roomId', 'HASH'), key('subscriptionId', 'RANGE')], Projection: { ProjectionType: 'ALL' } },
      ],
      ...PAY,
    },
    {
      TableName: T('transactions'),
      KeySchema: [key('workosUserId', 'HASH'), key('txnId', 'RANGE')],
      AttributeDefinitions: [attr('workosUserId', 'S'), attr('txnId', 'S')],
      ...PAY,
    },
    {
      TableName: T('expenses'),
      KeySchema: [key('roomId', 'HASH'), key('expenseId', 'RANGE')],
      AttributeDefinitions: [attr('roomId', 'S'), attr('expenseId', 'S'), attr('idempotencyKey', 'S')],
      GlobalSecondaryIndexes: [{
        IndexName: 'gsi1-idem', KeySchema: [key('idempotencyKey', 'HASH')],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
      ...PAY,
    },
    {
      TableName: T('balances'),
      KeySchema: [key('roomId', 'HASH'), key('pairKey', 'RANGE')],
      AttributeDefinitions: [attr('roomId', 'S'), attr('pairKey', 'S')],
      ...PAY,
    },
    {
      TableName: T('settlements'),
      KeySchema: [key('roomId', 'HASH'), key('settlementId', 'RANGE')],
      AttributeDefinitions: [attr('roomId', 'S'), attr('settlementId', 'S'), attr('idempotencyKey', 'S')],
      GlobalSecondaryIndexes: [{
        IndexName: 'gsi1-idem', KeySchema: [key('idempotencyKey', 'HASH')],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
      ...PAY,
    },
    {
      TableName: T('invitations'),
      KeySchema: [key('token', 'HASH')],
      AttributeDefinitions: [attr('token', 'S'), attr('roomId', 'S')],
      GlobalSecondaryIndexes: [{
        IndexName: 'gsi1-room', KeySchema: [key('roomId', 'HASH')],
        Projection: { ProjectionType: 'ALL' },
      }],
      ...PAY,
    },
    {
      TableName: T('outbox'),
      KeySchema: [key('eventId', 'HASH')],
      AttributeDefinitions: [attr('eventId', 'S'), attr('status', 'S'), attr('nextAttemptAt', 'N')],
      GlobalSecondaryIndexes: [{
        IndexName: 'gsi1-due', KeySchema: [key('status', 'HASH'), key('nextAttemptAt', 'RANGE')],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
      ...PAY,
    },
    {
      TableName: T('locks'),
      KeySchema: [key('lockKey', 'HASH')],
      AttributeDefinitions: [attr('lockKey', 'S')],
      ...PAY,
    },
    {
      TableName: T('idempotency'),
      KeySchema: [key('key', 'HASH')],
      AttributeDefinitions: [attr('key', 'S')],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      ...PAY,
    },
  ];
}

/* Creates missing tables; safe to call repeatedly. testId prefixes names for isolation. */
async function ensureTables(rawClient, prefix) {
  const listed = await rawClient.send(new ListTablesCommand({}));
  const have = new Set(listed.TableNames || []);
  for (const def of definitions(prefix)) {
    if (!have.has(def.TableName)) await rawClient.send(new CreateTableCommand(def));
  }
}

module.exports = { definitions, ensureTables };
