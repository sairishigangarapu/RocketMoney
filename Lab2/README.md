# Lab 2 — Agile Project Management with Jira

**Problem Statement #32 — Personal Subscription & Recurring Expense Auditor**

**Author:** Sai Rishi Gangarapu · SRN PES1UG24CS400 · Section 5G

📄 Full submission (with all screenshots): [`PES1UG24CS400_Lab2.pdf`](./PES1UG24CS400_Lab2.pdf)

🔗 **Jira Workspace:** <https://sairishigangarapu.atlassian.net/jira/software/projects/SCRUM/boards/1>

## Scope

This lab applies agile project management to the RocketMoney requirements from
[Lab 1](../Lab1/): the backlog is decomposed into Epics and User Stories, estimated with
Fibonacci story points, planned and executed across sprints on an active Scrum board, and
tracked with burndown charts.

## Contents

### 1. Epics & User Stories / Backlog (with Story Points)

A populated backlog containing **3 Epics** and their associated user stories, each with a
story-point estimate from the **Fibonacci sequence**:

- **Epic 1: Bank Integration & Data Sync** — e.g. *"As a user, I want to securely connect my
  bank account via a read-only API..."* (8 points), *"As a user, I want the system to fetch my
  transaction history for the last 90 days..."* (3 points), *"As a system auditor, I want
  financial transactions parsed securely without storing raw banking credentials..."* (5 points)
- **Epic 2: Subscription Detection & Dashboard** — e.g. *"As a user, I want to view a dashboard
  of all active subscriptions and their costs..."* (3 points)
- **Epic 3: Subscription Cancellation Services** — e.g. *"As a user, I want to receive an
  automated alert 3 days before a subscription renews..."* (3 points)

### 2. Active Sprint Board

Sprint 1 executed on a Scrum board with **To Do → In Progress → In Review → Done** columns,
demonstrating how user stories transitioned through the sprint lifecycle and completed sprint
goals.

### 3. Burndown Chart (Two Completed Sprints)

The burndown chart after successfully completing both sprints — story points burned down
against the total commitment, alongside workspace analytics (status overview, priority
breakdown, epic progress at 100%).

### 4. Reflection Answers

- **Story pointing:** Fibonacci estimation highlighted relative complexity (e.g. the secure
  API integration at 8 pts vs. a simple UI dashboard at 3 pts), preventing overcommitment and
  keeping velocity realistic.
- **Challenges:** Sprint 1's bank-integration complexity under strict security requirements was
  resolved by breaking the Epic into smaller stories (separating the 90-day sync logic from the
  secure credential parser) and collaborating closely on the backend architecture.
- **Burndown insight:** an early plateau during API research was followed by a sharp decline as
  backend integration stories moved to Done, completing sprint goals on time.
