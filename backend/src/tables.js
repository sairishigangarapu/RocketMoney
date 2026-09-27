'use strict';
/* Multi-table names (ADR-003, DYNAMODB-DESIGN.md). Prefix isolates envs: rm-dev-*, rm-test-*. */
const TABLES = [
  'users', 'rooms', 'memberships', 'subscriptions', 'transactions', 'expenses',
  'balances', 'settlements', 'invitations', 'outbox', 'locks', 'idempotency',
];
function tableNames(prefix = process.env.DYNAMODB_TABLE_PREFIX || 'rm-dev-') {
  return Object.fromEntries(TABLES.map((t) => [t, `${prefix}${t}`]));
}
module.exports = { TABLES, tableNames };
