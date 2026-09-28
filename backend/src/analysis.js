'use strict';
/* Recurring-expense analysis behind the RecurringAnalysisPort (ADR-006, FR-001, NFR-007).
 * Baseline detector (deterministic, always available): groups normalized merchants, finds
 * charges repeating on a ~monthly cadence, estimates monthly cost + next renewal.
 * SkillOpt path: optional external endpoint (SKILLOPT_ENDPOINT). Any failure, timeout, or
 * absence falls back to baseline. Every invocation records wall-clock RTT + fallback flag.
 */
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

const MONTH_MS = 30 * 24 * 3600 * 1000;
const CADENCE_TOLERANCE = 6 * 24 * 3600 * 1000;
const SKILLOPT_TIMEOUT_MS = 5000;

/* Pure detector over {merchantNorm, amountMinor, bookedAt} rows. */
function detectRecurring(txns) {
  const byMerchant = new Map();
  for (const t of txns) {
    if (!byMerchant.has(t.merchantNorm)) byMerchant.set(t.merchantNorm, []);
    byMerchant.get(t.merchantNorm).push(t);
  }
  const found = [];
  for (const [merchant, rows] of byMerchant) {
    const charges = rows
      .map((r) => ({ ts: Date.parse(r.bookedAt), amountMinor: r.amountMinor }))
      .filter((c) => Number.isFinite(c.ts) && c.amountMinor > 0)
      .sort((a, b) => a.ts - b.ts);
    if (charges.length < 2) continue;
    // Same-amount charges spaced ~30d apart (tolerance for billing jitter).
    const groups = new Map();
    for (const c of charges) {
      groups.set(c.amountMinor, (groups.get(c.amountMinor) || []).concat(c.ts));
    }
    for (const [amountMinor, times] of groups) {
      if (times.length < 2) continue;
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      const monthly = gaps.filter((g) => Math.abs(g - MONTH_MS) <= CADENCE_TOLERANCE).length;
      if (monthly >= 1 && monthly === gaps.length) {
        const last = times[times.length - 1];
        found.push({
          merchant, amountMinor, occurrences: times.length,
          renewalDate: new Date(last + MONTH_MS).toISOString().slice(0, 10),
          monthlyMinor: amountMinor,
        });
      }
    }
  }
  return found;
}

async function callSkillOpt(rows) {
  const endpoint = process.env.SKILLOPT_ENDPOINT;
  if (!endpoint) return null; // experiment not configured -> baseline
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SKILLOPT_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: rows.map((r) => ({ merchant: r.merchantNorm, amountMinor: r.amountMinor, bookedAt: r.bookedAt })) }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.subscriptions)) return null;
    return data.subscriptions;
  } catch {
    return null; // any failure -> deterministic fallback (ADR-006)
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeUser({ doc, tables }, { userId }) {
  const q = await doc.send(new QueryCommand({
    TableName: tables.transactions,
    KeyConditionExpression: 'workosUserId = :u',
    ExpressionAttributeValues: { ':u': userId },
  }));
  const rows = q.Items || [];
  const t0 = Date.now();
  const optimized = await callSkillOpt(rows);
  const rttMs = Date.now() - t0;
  if (optimized) {
    return { subscriptions: optimized, rttMs, fallbackUsed: false, analyzed: rows.length };
  }
  return { subscriptions: detectRecurring(rows), rttMs, fallbackUsed: true, analyzed: rows.length };
}

module.exports = { detectRecurring, analyzeUser, SKILLOPT_TIMEOUT_MS };
