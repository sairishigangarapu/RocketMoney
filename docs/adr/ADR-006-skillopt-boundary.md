# ADR-006 — SkillOpt Integration Boundary

- Status: Accepted (2026-09-27; Q6: sync-with-fallback, metrics = wall-clock RTT + latency).
- Context: Brief asks to experiment with SkillOpt for recurring-expense analysis without coupling
  the core to it.
- Decision: SkillOpt sits behind a `RecurringAnalysisPort` adapter used ONLY by Recurring Expense
  Analysis (merchant normalization, classification, cost estimation, quality scoring). Invocation is
  synchronous with a bounded timeout; any failure/timeout falls back to the deterministic baseline
  so the app works without SkillOpt. Contract, fallback, and evaluation are documented at the port.
- Alternatives: SkillOpt everywhere (rejected: coupling); async-batch-only (rejected for M4;
  may revisit post-MVP).
- Rationale: Isolates the experiment; keeps the critical path dependable.
- Consequences: Evaluation logs wall-clock RTT and latency (p50/p95) per invocation, SkillOpt vs
  baseline. No "AI-powered" claims without measured numbers.
