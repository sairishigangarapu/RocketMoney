# ADR-004 — DynamoDB-backed Distributed Locking

- Status: Accepted (2026-09-27).
- Context: Concurrent joins, expense/settlement writes, subscription updates, outbox claims, and
  scheduled notifications need mutual exclusion.
- Decision: Lease locks in the `locks` table (`lockKey` PK, `owner`, `expiry`). Conditional acquire
  (`attribute_not_exists` or expired), 10–30 s leases, heartbeat only for long analysis jobs,
  expiry-as-crash-safety with version fencing. Contention → 409 + bounded backoff.
- Alternatives: No locking (rejected: double-join/double-settle races); external lock service
  (rejected: extra dependency for M4 scope).
- Rationale: Co-located with the primary store, no new infra, conditional writes give correctness.
- Consequences: Every protected op documents WHAT/WHY/HOW-contention-handled/crash-behaviour; M5
  concurrency tests (lock failure, expiry, worker crash) are mandatory.
