'use strict';
/* M4c integration tests vs DynamoDB Local (issue #8 acceptance). Run: npm run test:integration */
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
const subscriptions = require('../src/subscriptions');
const transactions = require('../src/transactions');
const analysis = require('../src/analysis');
const notify = require('../src/notify');
const reports = require('../src/reports');
const metrics = require('../src/metrics');

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

async function outboxTypesFor(aggId) {
  const q = await doc.send(new QueryCommand({
    TableName: tables.outbox, IndexName: 'gsi1-due',
    KeyConditionExpression: '#s = :p', ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':p': 'PENDING' },
  }));
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const types = [];
  for (const c of q.Items || []) {
    // eslint-disable-next-line no-await-in-loop
    const full = await doc.send(new GetCommand({ TableName: tables.outbox, Key: { eventId: c.eventId } }));
    if (full.Item && full.Item.aggregateId === aggId) types.push(full.Item.type);
  }
  return types;
}

test('subscription CRUD: create personal, read own, stranger 404, cancel', async () => {
  const owner = uid('o');
  const { subscription } = await subscriptions.createSubscription(ctx, {
    ownerId: owner, provider: 'Netflix', amountMinor: 64900, renewalDate: '2026-12-05',
  });
  assert.ok(!subscription.roomId, 'personal subscription links no room');
  assert.equal(subscription.status, 'ACTIVE');
  const got = await subscriptions.getSubscription(ctx, { requesterId: owner, subscriptionId: subscription.subscriptionId });
  assert.equal(got.subscription.provider, 'Netflix');
  await assert.rejects(
    subscriptions.getSubscription(ctx, { requesterId: uid('s'), subscriptionId: subscription.subscriptionId }),
    (e) => e.statusCode === 404,
  );
  const done = await subscriptions.confirmCancelled(ctx, { requesterId: owner, subscriptionId: subscription.subscriptionId });
  assert.equal(done.status, 'CANCELLED');
  const mine = await subscriptions.listMySubscriptions(ctx, { userId: owner });
  assert.ok(!mine.some((s) => s.subscriptionId === subscription.subscriptionId), 'cancelled leaves the active list');
});

test('shared link: owner-only, single-room invariant, member-visible', async () => {
  const owner = uid('o');
  const { subscription } = await subscriptions.createSubscription(ctx, {
    ownerId: owner, provider: 'Spotify', amountMinor: 11900, renewalDate: '2026-11-01',
  });
  const { room } = await rooms.createRoom(ctx, { ownerId: owner, name: 'Music' });
  const inv = await rooms.generateInvite(ctx, { actorId: owner, roomId: room.roomId, maxUses: 2 });
  const member = uid('m');
  await rooms.joinRoom(ctx, { userId: member, token: inv.token });
  await assert.rejects(
    subscriptions.linkToRoom(ctx, { actorId: member, subscriptionId: subscription.subscriptionId, roomId: room.roomId }),
    (e) => e.statusCode === 403,
  );
  const linked = await subscriptions.linkToRoom(ctx, { actorId: owner, subscriptionId: subscription.subscriptionId, roomId: room.roomId });
  assert.equal(linked.roomId, room.roomId);
  const seen = await subscriptions.getSubscription(ctx, { requesterId: member, subscriptionId: subscription.subscriptionId });
  assert.equal(seen.subscription.roomId, room.roomId);
  const { room: room2 } = await rooms.createRoom(ctx, { ownerId: owner, name: 'Second' });
  await assert.rejects(
    subscriptions.linkToRoom(ctx, { actorId: owner, subscriptionId: subscription.subscriptionId, roomId: room2.roomId }),
    (e) => e.code === 'already-shared',
  );
});

test('CSV import is idempotent per batch; bad files rejected', async () => {
  const user = uid('u');
  const csv = 'date,merchant,amount\n2026-06-05,Netflix,649.00\n2026-07-05,Netflix,649.00\n2026-07-06,Cafe,120.50\n';
  const r1 = await transactions.importTransactions(ctx, { userId: user, source: 'CSV', batchId: 'b1', csvText: csv });
  assert.deepEqual([r1.imported, r1.skipped], [3, 0]);
  const r2 = await transactions.importTransactions(ctx, { userId: user, source: 'CSV', batchId: 'b1', csvText: csv });
  assert.deepEqual([r2.imported, r2.skipped], [0, 3]);
  await assert.rejects(
    transactions.importTransactions(ctx, { userId: user, source: 'CSV', batchId: 'b2', csvText: 'nope' }),
    (e) => e.code === 'bad-csv',
  );
});

test('analysis falls back deterministically and records RTT', async () => {
  const user = uid('u');
  delete process.env.SKILLOPT_ENDPOINT;
  const csv = 'date,merchant,amount\n2026-06-05,Netflix,649.00\n2026-07-05,Netflix,649.00\n2026-08-05,Netflix,649.00\n';
  await transactions.importTransactions(ctx, { userId: user, source: 'CSV', batchId: 'ba', csvText: csv });
  const out = await analysis.analyzeUser(ctx, { userId: user });
  assert.equal(out.fallbackUsed, true);
  assert.ok(Number.isFinite(out.rttMs) && out.rttMs >= 0);
  assert.equal(out.analyzed, 3);
  assert.equal(out.subscriptions.length, 1);
  assert.equal(out.subscriptions[0].merchant, 'netflix');
});

test('renewal scan emits approaching events for due subscriptions', async () => {
  const owner = uid('o');
  const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { subscription } = await subscriptions.createSubscription(ctx, {
    ownerId: owner, provider: 'Soon+', amountMinor: 99900, renewalDate: soon,
  });
  const out = await notify.scanRenewals(ctx, { ownerId: owner });
  assert.ok(out.emitted.includes(subscription.subscriptionId));
  const types = await outboxTypesFor(subscription.subscriptionId);
  assert.ok(types.includes('SubscriptionRenewalApproaching'));
});

test('concierge: explicit auth required, owner only, records pending', async () => {
  const owner = uid('o');
  const { subscription } = await subscriptions.createSubscription(ctx, {
    ownerId: owner, provider: 'GymPro', amountMinor: 200000, renewalDate: '2026-12-01',
  });
  await assert.rejects(
    notify.requestConcierge(ctx, { requesterId: owner, subscriptionId: subscription.subscriptionId, authorization: 'ok' }),
    (e) => e.code === 'bad-auth',
  );
  await assert.rejects(
    notify.requestConcierge(ctx, { requesterId: uid('s'), subscriptionId: subscription.subscriptionId, authorization: 'I, X, authorize cancellation of GymPro.' }),
    (e) => e.statusCode === 404 || e.statusCode === 403,
  );
  const r = await notify.requestConcierge(ctx, {
    requesterId: owner, subscriptionId: subscription.subscriptionId,
    authorization: 'I, the account holder, authorize RocketMoney to cancel GymPro on my behalf.',
  });
  assert.equal(r.status, 'PENDING_CONCIERGE');
  const done = await subscriptions.confirmCancelled(ctx, { requesterId: owner, subscriptionId: subscription.subscriptionId });
  assert.equal(done.status, 'CANCELLED');
});

test('reports: CSV has aggregates without identity; PDF is a real PDF', async () => {
  const owner = uid('o');
  await subscriptions.createSubscription(ctx, {
    ownerId: owner, provider: `Prov${Date.now()}`, amountMinor: 50000, renewalDate: '2026-12-01',
  });
  const csv = await reports.buildReport(ctx, { format: 'csv' });
  assert.equal(csv.contentType, 'text/csv');
  assert.match(csv.body, /provider,subscriptions,monthly_minor,monthly_rupees/);
  assert.ok(!csv.body.includes(owner) && !csv.body.includes('@'), 'no identity in report');
  const pdf = await reports.buildReport(ctx, { format: 'pdf' });
  assert.equal(pdf.contentType, 'application/pdf');
  assert.ok(Buffer.isBuffer(pdf.body) && pdf.body.slice(0, 4).toString() === '%PDF');
});

test('notifier: webhook delivery with signature; failure falls back to log', async () => {
  const http = require('node:http');
  const { signPayload } = require('../src/notify');
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  process.env.NOTIFY_WEBHOOK_URL = `http://localhost:${port}/hook`;
  process.env.NOTIFY_WEBHOOK_SECRET = 's3cret';
  try {
    const out = await notify.sendNotification({ channel: 'webhook', toUserId: 'u1', subject: 'Renewal', body: 'Due' });
    assert.equal(out.delivered, 'webhook');
    assert.equal(received.length, 1);
    assert.equal(received[0].body.subject, 'Renewal');
    assert.equal(
      received[0].headers['x-rocketmoney-signature'],
      signPayload(JSON.stringify(received[0].body), 's3cret'),
    );
  } finally {
    server.close();
    delete process.env.NOTIFY_WEBHOOK_URL;
    delete process.env.NOTIFY_WEBHOOK_SECRET;
  }
  // Unreachable webhook never throws: falls back to log transport.
  process.env.NOTIFY_WEBHOOK_URL = 'http://localhost:1/closed';
  try {
    const out = await notify.sendNotification({ channel: 'webhook', toUserId: 'u1', subject: 'Hi', body: 'B' });
    assert.equal(out.delivered, 'log');
  } finally {
    delete process.env.NOTIFY_WEBHOOK_URL;
  }
});

test('dashboard figures equal owned actives plus room outstanding', async () => {
  const owner = uid('o');
  await subscriptions.createSubscription(ctx, {
    ownerId: owner, provider: 'DashA', amountMinor: 10000, renewalDate: '2026-12-01',
  });
  await subscriptions.createSubscription(ctx, {
    ownerId: owner, provider: 'DashB', amountMinor: 20000, renewalDate: '2026-12-01',
  });
  const dash = await metrics.dashboard(ctx, { userId: owner });
  assert.ok(dash.personalMinor >= 30000);
  assert.ok(Array.isArray(dash.rooms));
  assert.equal(typeof dash.totalOutstandingMinor, 'number');
});
