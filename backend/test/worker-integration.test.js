'use strict';
/* Worker + scheduler integration tests (TC-WORK-01) vs DynamoDB Local. */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { GetCommand } = require('@aws-sdk/lib-dynamodb');

process.env.DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
process.env.DYNAMODB_TABLE_PREFIX = 'rm-test-';
process.env.AWS_REGION = 'ap-south-1';

const { createDocClient } = require('../src/db');
const { tableNames } = require('../src/tables');
const { ensureTables } = require('../src/schema');
const subscriptions = require('../src/subscriptions');
const notify = require('../src/notify');
const { pollOnce, scanAllRenewals } = require('../src/worker');

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

async function receiver() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { got.push(JSON.parse(body)); res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, r));
  return { server, got, url: `http://localhost:${server.address().port}/hook` };
}

test('worker delivers a renewal alert end-to-end then idles', async () => {
  const { server, got, url } = await receiver();
  process.env.NOTIFY_WEBHOOK_URL = url;
  try {
    // Drain backlog first so the polls below deterministically reach our event.
    for (let i = 0; i < 2000; i++) {
      // eslint-disable-next-line no-await-in-loop
      const drained = await pollOnce(ctx, 'drain-worker');
      if (!drained) break;
    }
    const drainedCheck = await pollOnce(ctx, 'drain-worker');
    assert.equal(drainedCheck, null);
    const owner = uid('o');
    const tag = `WorkerCo-${Date.now()}-${n}`;
    const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { subscription } = await subscriptions.createSubscription(ctx, {
      ownerId: owner, provider: tag, amountMinor: 10000, renewalDate: soon,
    });
    const scan = await notify.scanRenewals(ctx, { ownerId: owner });
    assert.ok(scan.emitted.includes(subscription.subscriptionId));
    // Drain exactly this event (other PENDING rows may exist from other suites).
    let delivered = null;
    for (let i = 0; i < 50 && !delivered; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await pollOnce(ctx, `test-worker-${Date.now()}`);
      if (!r) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((x) => setTimeout(x, 100));
        continue;
      }
      if (got.some((g) => g.subject && g.subject.includes(tag))) delivered = r;
    }
    assert.ok(delivered, 'renewal event delivered through worker');
    assert.equal(got.filter((g) => g.subject.includes(tag)).length, 1);
    const row = await doc.send(new GetCommand({ TableName: tables.outbox, Key: { eventId: delivered.eventId } }));
    assert.equal(row.Item.status, 'DONE');
  } finally {
    delete process.env.NOTIFY_WEBHOOK_URL;
    server.close();
  }
});

test('scanAllRenewals covers every owner with due subscriptions', async () => {
  const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const owners = [uid('a'), uid('b')];
  for (const o of owners) {
    // eslint-disable-next-line no-await-in-loop
    await subscriptions.createSubscription(ctx, { ownerId: o, provider: 'ScanCo', amountMinor: 5000, renewalDate: soon });
  }
  const out = await scanAllRenewals(ctx);
  assert.ok(out.owners >= 2);
  assert.ok(out.emitted.length >= 2);
});
