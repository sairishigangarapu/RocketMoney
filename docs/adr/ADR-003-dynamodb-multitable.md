# ADR-003 — Multi-table DynamoDB as Primary Datastore

- Status: Accepted (2026-09-27; Q3 decision: multi-table over single-table).
- Context: DynamoDB must serve OLTP access patterns (profile, subscriptions, room/members,
  expenses/balances/settlements, renewals, outbox, locks) with conditional writes and atomicity.
- Decision: Multi-table (tables: `users, rooms, memberships, subscriptions, transactions,
  expenses, balances, settlements, invitations, outbox, locks, idempotency`). Cross-item atomicity
  via TransactWrite within/beside a lock; GSIs for rooms-owned, rooms-joined, renewals,
  outbox-due. Key details in `docs/ARCHITECTURE.md` §2.
- Alternatives: Single-table (rejected per Q3: team prefers aggregate-per-table clarity and
  independent throughput/scaling over item-collection packing for this workload).
- Rationale: Clearer ownership per aggregate, simpler IAM/TTL/GSI evolution, still transactional
  where it counts (expense+balances+outbox bundles).
- Consequences: More tables to provision/manage; M3 must finalise GSIs, RCU/WCU or on-demand
  choice, and hot-partition review per table.
