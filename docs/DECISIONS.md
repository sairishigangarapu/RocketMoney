# Approved Architecture Decisions (Q0–Q7) — M2 Gate Log

Date: 2026-09-27. Status: **APPROVED baseline**. Any change requires an ADR amendment.

| ID | Question | Decision |
|----|----------|----------|
| Q0 | Repo topology | `SoftwareEngg` (this checkout) = lab archive. All new engineering lives in `RocketMoney/` (this folder), which is promoted to `sairishigangarapu/RocketMoney`. Folder name uses no space (`RocketMoney/`) because spaces break JS/TS tooling; rename is trivial if the evaluators insist on the literal `rocket money`. |
| Q1 | WorkOS sync transport | **APPROVED as proposed: WorkOS Events + Webhooks** (`user.created/updated/deleted`), signature-verified, idempotent handler, poll/replay for recovery. See ADR-010. |
| Q2 | Owner departure lifecycle | **Mandatory ownership transfer: an owner MUST designate another member as owner before exiting.** Exit with no successor is rejected (4xx). If the owner identity is deleted/deactivated in WorkOS without a transfer, the room is **frozen** (no new expenses/settlements) until a successor is assigned; balances/settlements/audit history are retained. See ADR-010. |
| Q3 | DynamoDB modelling | **Multi-table** (overrides single-table proposal). One table per aggregate; cross-table consistency via TransactWrite for domain+outbox and lease-locks for multi-step flows. See ADR-003. |
| Q4 | Split strategies for MVP | **APPROVED as proposed: equal-split only in MVP.** Exact/percentage/custom deferred to post-MVP issues. See ADR-008. |
| Q5 | Balance model | **APPROVED as proposed: hybrid** — append-only expense/settlement event log + materialized pairwise balances updated transactionally under lock. See ADR-008. |
| Q6 | SkillOpt coupling + metric | **APPROVED as proposed: sync-with-timeout + deterministic fallback.** Evaluation metrics: **wall-clock RTT and latency** (p50/p95) of the analysis path, SkillOpt vs baseline. See ADR-006. |
| Q7 | Stack | **Fastify JS backend (OLTP-first) + TSX (React) frontend.** Backend: Node + Fastify, DynamoDB via SDK, short transactions, conditional writes. Frontend: React + TypeScript (`.tsx`), Brutalist design tokens. See ADR-001. |

## Consequences applied across the baseline

- ADR-003 rewritten for multi-table (table list + key design + which TransactWrite bundles what).
- ADR-010 encodes the Q2 transfer-or-freeze rule and the frozen-room semantics.
- ADR-008 locks MVP to equal-split; other strategies are explicitly out of scope for M4.
- ADR-006 evaluation plan measures wall-clock RTT/latency; no "AI-powered" claims without numbers.
- Backend scaffold (`backend/`) implements fail-fast startup + graceful shutdown first, per §§5–6 of the brief.
