# Lab 1 — Requirements Engineering & UML Use-Case Modelling

**Problem Statement #32 — Retail, E-Commerce & Finance:** *Personal Subscription & Recurring Expense Auditor*

**Author:** Sai Rishi Gangarapu · SRN PES1UG24CS400 · Section G

📄 Full submission: [`PES1UG24CS400_Requirements_Engineering.pdf`](./PES1UG24CS400_Requirements_Engineering.pdf)

## Scope

This lab establishes the foundation for the RocketMoney project: a complete requirements
specification and UML use-case model for a subscription auditing application that identifies
recurring billing patterns, alerts users before renewals, and provides cancellation assistance.

## Contents

### 1. Requirements Table

**Functional Requirements (FR-001 – FR-005)**

| ID | Type | Summary | Priority |
|----|------|---------|----------|
| FR-001 | Core Feature | Analyze transaction logs to detect recurring billing patterns and project monthly subscription expenditure | High |
| FR-002 | Integration | Connect bank accounts via secure read-only APIs to import transaction history automatically | High |
| FR-003 | Notification | Alert the user at least 72 hours before an identified subscription renewal | High |
| FR-004 | Core Feature | Provide step-by-step cancellation guides or direct links to cancellation portals | Medium |
| FR-005 | Reporting | Export anonymized, aggregated monthly burn-rate reports (CSV/PDF) for the Finance Auditor | Low |

Each requirement carries explicit pass/fail acceptance criteria and a rationale.

**Non-Functional Requirements**

- **NFR-001 (Security & Compliance, High):** financial imports must parse securely — no raw
  banking credentials stored in cleartext anywhere in the system (PCI-DSS-aligned).
- **NFR-002 (Performance, Medium):** dashboard must compute and render the monthly burn rate
  within 2.0 seconds for transaction logs of up to 10,000 records.

### 2. UML Use-Case Diagram

Models **Individual User**, **Finance Auditor**, and an external **Bank API**, including an
`<<include>>` relationship (viewing the dashboard requires log analysis) and an `<<extend>>`
relationship (standard cancellation optionally extended by automated concierge cancellation).

### 3. Use-Case Flow Specification

Fully specified **Cancel Subscription** use case: preconditions, postconditions, an 8-step
main success scenario, and an alternate **Concierge Cancellation** extension flow (steps 4a1–4a5)
where the user authorizes the application to cancel on their behalf asynchronously.

## How this feeds the project

These requirements are the source of truth for the layered architecture designed in
[Lab 3](../Lab3/) and evolved in [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), and the
requirements themselves live in [`docs/REQUIREMENTS.md`](../docs/REQUIREMENTS.md).
