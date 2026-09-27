# Baseline Issues (minimal, iterative)

Create these as GitHub issues in `sairishigangarapu/RocketMoney` in order. Each follow-up uses
one branch per issue (`feature/<n>-<slug>`) + one PR. Statuses live in the GitHub Project board
(Backlog → Ready → In Progress → In Review → Testing → Done → Blocked).

## #3 — M0/M2: Project init + architecture baseline ✅ CLOSED (on `main`)

- Objective: land `RocketMoney/` skeleton, approved architecture, ADRs 001–010.
- Acceptance: docs merged; backend boots fail-fast/graceful (verified); frontend placeholder builds.
- Traceability: M0, M2 gate; ADR-001…010.

## #4 — M1: Requirements baseline (FR/NFR/SEC/ROOM/EXP)

- Objective: numbered, testable requirements with IDs extending Lab 1 (FR-001–005, NFR-001–002).
- Scope: personal + rooms + splitting + settlements + sync lifecycle + SkillOpt eval.
- Acceptance: every requirement has acceptance criteria + maps to an issue in #5–#9.
- DoD: `docs/REQUIREMENTS.md` merged; traceability matrix started.

## #5 — M3: DynamoDB multi-table detailed design

- Objective: final key schemas, GSIs, TransactWrite bundles, RCU/WCU or on-demand per table.
- Acceptance: all §2 access patterns mapped; hot-partition review; conditional-write plan.
- Traceability: ADR-003; ROOM/EXP requirements.

## #6 — M4a (slice): Rooms + invitations + owner-transfer-freeze

- Objective: room CRUD, invite tokens, join race guards, mandatory successor transfer, freeze flow.
- Acceptance: double-join safe; owner exit without successor → 4xx; frozen room rejects writes.
- Traceability: ADR-007, ADR-010; ROOM-* requirements.

## #7 — M4b (slice): Equal-split expenses + settlements + hybrid ledger

- Objective: expense create (equal only), materialized pairwise balances, settlement machine.
- Acceptance: ₹1,000/5 example settles correctly; double-settle safe; audit log rebuilds balances.
- Traceability: ADR-008; EXP-* requirements.

## #8 — M4c (slice): Subscriptions, notifications, cancellation, reports, SkillOpt hookup

- Objective: personal vs shared subscriptions, 72h renewal alerts, cancellation guides/concierge
  stubs, CSV/PDF anonymized reports, SkillOpt adapter with RTT/latency logging + fallback.
- Acceptance: core flows work with SkillOpt disabled (fallback path).
- Traceability: ADR-006; FR-001…005.

## #9 — M5: Test plan + concurrency matrix

- Objective: IEEE-style plan, 7–10+ cases incl. double-join, double-settle, duplicate outbox
  delivery, lock expiry, worker crash, fail-fast/shutdown tests.
- Acceptance: CI runs build + unit + integration + lint; PRs blocked on red.
- Traceability: all requirements → test cases.

## #10 — CI/CD workflow

- Objective: GitHub Actions (build, test, lint, report) on every PR.
- Acceptance: red CI blocks merge; commands match the actual stack (no invented steps).
- Traceability: phase-gate M5.
