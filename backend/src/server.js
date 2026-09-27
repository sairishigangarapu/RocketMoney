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

  fastify.get('/health', async () => ({ status: 'ok', uptimeMs: Date.now() - startedAt }));
  fastify.get('/ready', async () => ({ ready: true })); // deep checks (DynamoDB/WorkOS) land in M3

  // M4 route stubs — explicitly unimplemented so nothing pretends to work.
  const notImpl = async (req, reply) => {
    log({ level: 'warn', op: req.routeOptions.url, outcome: 'not-implemented' });
    return reply.code(501).send({ error: 'not-implemented', milestone: 'M4' });
  };
  for (const [method, url] of [
    ['POST', '/api/rooms'],
    ['POST', '/api/rooms/:id/join'],
    ['POST', '/api/rooms/:id/expenses'],
    ['POST', '/api/rooms/:id/settlements'],
    ['POST', '/api/webhooks/workos'],
  ]) {
    fastify.route({ method, url, handler: notImpl });
  }
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
