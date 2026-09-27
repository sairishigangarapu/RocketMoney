# RocketMoney

Personal Subscription & Recurring Expense Auditor with collaborative Rooms.
Stack (M2-approved, Q7): **Fastify JS backend (OLTP-first) + React TSX frontend**, DynamoDB
multi-table, WorkOS identity. See `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/adr/`.

## Layout

- `docs/` — baselined architecture, decision log, ADRs 001–010.
- `backend/` — Fastify API skeleton (M0: fail-fast startup + graceful shutdown + route stubs).
- `frontend/` — React TSX skeleton (M0: brutalist placeholder; system tokens land in M3/M4).

## Status

M0–M3 baselined and merged. M4a (rooms/invites/sync, issue #6) in progress. No domain implementation until M4. Phase gates: M1 requirements → M2
architecture (done) → M3 detailed design → M4 MVP → M5 tests → M6 hardening → M7 release.
