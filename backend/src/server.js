'use strict';
/* RocketMoney backend — M0 skeleton.
 * M2 mandates: fail-fast startup (§5) + graceful shutdown (§6). No domain logic until M4.
 * Tables (ADR-003 multi-table): users, rooms, memberships, subscriptions, transactions,
 * expenses, balances, settlements, invitations, outbox, locks, idempotency.
 */

const REQUIRED_ENV = ['WORKOS_API_KEY', 'AWS_REGION', 'DYNAMODB_TABLE_PREFIX'];

function failFast() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    // Never log secret values — only names.
    console.error(
      JSON.stringify({
        level: 'fatal',
        component: 'startup',
        reason: 'missing-required-env',
        missing,
        retryable: false,
      })
    );
    process.exit(1);
  }
  // WorkOS/DynamoDB live-connectivity checks land in M3 (clients wrapped in adapters).
}

function buildServer() {
  const fastify = require('fastify')({ logger: false });
  const startedAt = Date.now();
  const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

  fastify.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    log({ level: status >= 500 ? 'error' : 'warn', op: req.url, outcome: err.code || 'error', status });
    reply.code(status).send({ error: err.code || 'internal', message: status >= 500 ? 'internal error' : err.message });
  });

  // Webhook signature verification needs the exact raw bytes: keep the raw string for
  // /api/webhooks/* and JSON-parse everywhere else.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (req.url.startsWith('/api/webhooks/')) return done(null, body);
    try {
      done(null, body.length === 0 ? {} : JSON.parse(body));
    } catch (err) {
      done(Object.assign(new Error('malformed json'), { statusCode: 400, code: 'bad-json' }));
    }
  });

  const { createDocClient } = require('./db');
  const { tableNames } = require('./tables');
  const { requireUser } = require('./auth');
  const rooms = require('./rooms');
  const expenses = require('./expenses');
  const subscriptions = require('./subscriptions');
  const transactions = require('./transactions');
  const analysis = require('./analysis');
  const notify = require('./notify');
  const reports = require('./reports');
  const metrics = require('./metrics');
  const { handleWorkOSWebhook } = require('./sync');
  const ctx = { doc: createDocClient(), tables: tableNames() };

  const authed = (handler) => async (req, reply) => {
    const user = requireUser(req);
    return handler(req, reply, user.workosUserId);
  };

  fastify.get('/health', async () => ({ status: 'ok', uptimeMs: Date.now() - startedAt }));
  fastify.get('/ready', async () => ({ ready: true })); // deep checks (DynamoDB/WorkOS) land in M4c

  // ---- M4a: rooms ----
  fastify.post('/api/rooms', authed(async (req, reply, userId) => {
    const { room } = await rooms.createRoom(ctx, { ownerId: userId, name: req.body.name, settings: req.body.settings });
    return reply.code(201).send({ room });
  }));
  fastify.get('/api/rooms', authed(async (req, reply, userId) => {
    return { rooms: await rooms.listRooms(ctx, { userId }) };
  }));
  fastify.get('/api/rooms/:id', authed(async (req, reply, userId) => {
    return rooms.getRoom(ctx, { requesterId: userId, roomId: req.params.id });
  }));
  fastify.get('/api/rooms/:id/members', authed(async (req, reply, userId) => {
    return { members: await rooms.listMembers(ctx, { requesterId: userId, roomId: req.params.id }) };
  }));
  fastify.post('/api/rooms/:id/invites', authed(async (req, reply, userId) => {
    const invite = await rooms.generateInvite(ctx, {
      actorId: userId, roomId: req.params.id, maxUses: req.body.maxUses, ttlSec: req.body.ttlSec,
    });
    return reply.code(201).send({ invite });
  }));
  fastify.post('/api/rooms/:id/invites/revoke', authed(async (req, reply, userId) => {
    return rooms.revokeInvite(ctx, { actorId: userId, roomId: req.params.id, token: req.body.token });
  }));
  fastify.post('/api/join', authed(async (req, reply, userId) => {
    return rooms.joinRoom(ctx, { userId, token: req.body.token });
  }));
  fastify.post('/api/rooms/:id/transfer', authed(async (req, reply, userId) => {
    return rooms.transferOwnership(ctx, { actorId: userId, roomId: req.params.id, successorId: req.body.successorId });
  }));
  fastify.post('/api/rooms/:id/members/remove', authed(async (req, reply, userId) => {
    return rooms.removeMember(ctx, { actorId: userId, roomId: req.params.id, targetId: req.body.targetId });
  }));
  fastify.post('/api/rooms/:id/claim', authed(async (req, reply, userId) => {
    return rooms.claimFrozenRoom(ctx, { userId, roomId: req.params.id });
  }));

  // ---- M4a: WorkOS webhook (raw body preserved by the parser above) ----
  fastify.post('/api/webhooks/workos', async (req, reply) => {
    const outcome = await handleWorkOSWebhook(ctx, { rawBody: req.body, sigHeader: req.headers['workos-signature'] });
    return reply.code(202).send(outcome);
  });

  // ---- M4b: expenses & settlements ----
  fastify.post('/api/rooms/:id/expenses', authed(async (req, reply, userId) => {
    const { expense, duplicate } = await expenses.createExpense(ctx, {
      actorId: userId, roomId: req.params.id, amountMinor: req.body.amountMinor,
      payerId: req.body.payerId, participants: req.body.participants,
      idempotencyKey: req.body.idempotencyKey,
    });
    return reply.code(duplicate ? 200 : 201).send({ expense, duplicate });
  }));
  fastify.get('/api/rooms/:id/expenses', authed(async (req, reply, userId) => {
    return { expenses: await expenses.listExpenses(ctx, { requesterId: userId, roomId: req.params.id }) };
  }));
  fastify.get('/api/rooms/:id/balances', authed(async (req, reply, userId) => {
    return expenses.getBalances(ctx, { requesterId: userId, roomId: req.params.id });
  }));
  fastify.get('/api/rooms/:id/balances/rebuild', authed(async (req, reply, userId) => {
    return expenses.rebuildBalances(ctx, { requesterId: userId, roomId: req.params.id });
  }));
  fastify.post('/api/rooms/:id/settlements', authed(async (req, reply, userId) => {
    const { settlement, duplicate } = await expenses.requestSettlement(ctx, {
      actorId: userId, roomId: req.params.id, fromId: req.body.fromId, toId: req.body.toId,
      amountMinor: req.body.amountMinor, idempotencyKey: req.body.idempotencyKey,
    });
    return reply.code(duplicate ? 200 : 201).send({ settlement, duplicate });
  }));
  fastify.post('/api/rooms/:id/settlements/:sid/complete', authed(async (req, reply, userId) => {
    return expenses.completeSettlement(ctx, { actorId: userId, roomId: req.params.id, settlementId: req.params.sid });
  }));

  // ---- M4c: subscriptions, analysis, notifications, cancellation, reports ----
  fastify.post('/api/subscriptions', authed(async (req, reply, userId) => {
    const { subscription } = await subscriptions.createSubscription(ctx, {
      ownerId: userId, provider: req.body.provider, amountMinor: req.body.amountMinor,
      currency: req.body.currency, renewalDate: req.body.renewalDate,
    });
    return reply.code(201).send({ subscription });
  }));
  fastify.get('/api/subscriptions', authed(async (req, reply, userId) => {
    return { subscriptions: await subscriptions.listMySubscriptions(ctx, { userId }) };
  }));
  fastify.get('/api/subscriptions/:id', authed(async (req, reply, userId) => {
    return subscriptions.getSubscription(ctx, { requesterId: userId, subscriptionId: req.params.id });
  }));
  fastify.post('/api/subscriptions/:id/link', authed(async (req, reply, userId) => {
    return subscriptions.linkToRoom(ctx, { actorId: userId, subscriptionId: req.params.id, roomId: req.body.roomId });
  }));
  fastify.post('/api/subscriptions/:id/cancel', authed(async (req, reply, userId) => {
    return subscriptions.confirmCancelled(ctx, { requesterId: userId, subscriptionId: req.params.id });
  }));
  fastify.post('/api/transactions/import', authed(async (req, reply, userId) => {
    return transactions.importTransactions(ctx, {
      userId, source: req.body.source, batchId: req.body.batchId, csvText: req.body.csv,
    });
  }));
  fastify.get('/api/analysis', authed(async (req, reply, userId) => {
    return analysis.analyzeUser(ctx, { userId });
  }));
  fastify.post('/api/admin/scan-renewals', authed(async (req, reply, userId) => {
    return notify.scanRenewals(ctx, { ownerId: userId });
  }));
  fastify.get('/api/guides/:provider', async (req) => {
    return notify.cancellationGuide(req.params.provider);
  });
  fastify.post('/api/subscriptions/:id/concierge', authed(async (req, reply, userId) => {
    return notify.requestConcierge(ctx, {
      requesterId: userId, subscriptionId: req.params.id, authorization: req.body.authorization,
    });
  }));
  fastify.get('/api/reports/burn-rate', authed(async (req, reply) => {
    const format = req.query.format === 'pdf' ? 'pdf' : 'csv';
    const report = await reports.buildReport(ctx, { format });
    return reply.header('Content-Type', report.contentType).send(report.body);
  }));
  fastify.get('/api/dashboard', authed(async (req, reply, userId) => {
    return metrics.dashboard(ctx, { userId });
  }));

  return { fastify, log };
}

async function main() {
  failFast();
  const { fastify, log } = buildServer();
  const port = Number(process.env.PORT || 3000);

  // Graceful shutdown: stop intake → drain → close (bounded timeout).
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  let shuttingDown = false;
  const shutdown = (signal) => async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ level: 'info', component: 'shutdown', signal, outcome: 'draining' });
    const force = setTimeout(() => {
      log({ level: 'error', component: 'shutdown', outcome: 'timeout-exceeded' });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await fastify.close(); // stops intake, drains in-flight; workers/DB close added in M3/M4
      clearTimeout(force);
      log({ level: 'info', component: 'shutdown', outcome: 'clean-exit' });
      process.exit(0);
    } catch (err) {
      log({ level: 'error', component: 'shutdown', outcome: 'error', error: err.message });
      process.exit(1);
    }
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    log({ level: 'info', component: 'startup', outcome: 'listening', port });
  } catch (err) {
    log({ level: 'fatal', component: 'startup', reason: 'listen-failed', error: err.message });
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { failFast, buildServer };
