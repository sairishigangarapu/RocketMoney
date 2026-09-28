'use strict';
/* Notifications (FR-003) + cancellation guidance/concierge (FR-004/006).
 * Transport: webhook-first. When NOTIFY_WEBHOOK_URL is set, the notification is POSTed
 * as JSON (5s timeout; HMAC-SHA256 signature in X-RocketMoney-Signature when
 * NOTIFY_WEBHOOK_SECRET is set). Any failure — or no URL configured — falls back to a
 * structured log line, never throwing: durability lives in the outbox event, and the
 * worker retry path redrives delivery. The fallback philosophy mirrors ADR-006.
 * Cancellation guides are a static provider map with an explicit unsupported state —
 * never a dead link.
 */
const crypto = require('node:crypto');
const { TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { badRequest, forbidden, notFound } = require('./errors');
const { nowIso } = require('./ids');
const { newEvent, putEventItem } = require('./outbox');
const { getSubscription, renewalsDue } = require('./subscriptions');

const WEBHOOK_TIMEOUT_MS = 5000;

function signPayload(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function logLine(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', component: 'notifier', ...entry }));
}

async function postWebhook(url, payload, secret) {
  const rawBody = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-RocketMoney-Signature'] = signPayload(rawBody, secret);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: rawBody, signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function sendNotification({ channel, toUserId, subject, body }) {
  const payload = { toUserId, subject, body, sentAt: new Date().toISOString() };
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (url) {
    const ok = await postWebhook(url, payload, process.env.NOTIFY_WEBHOOK_SECRET);
    if (ok) {
      logLine({ outcome: 'webhook-delivered', channel, toUserId, subject });
      return { delivered: 'webhook', channel, toUserId };
    }
    logLine({ outcome: 'webhook-failed-fallback-log', channel, toUserId, subject });
  }
  logLine({ outcome: 'log', channel, toUserId, subject, body });
  return { delivered: 'log', channel, toUserId };
}

/* Owner-triggered scan: every owned subscription due within 72h emits an outbox event.
 * (Daily scheduler wiring is ops work; the scan itself is pure domain + outbox.) */
async function scanRenewals({ doc, tables }, { ownerId, withinMs }) {
  const due = await renewalsDue({ doc, tables }, { ownerId, withinMs });
  const emitted = [];
  for (const s of due) {
    // eslint-disable-next-line no-await-in-loop
    await doc.send(new TransactWriteCommand({
      TransactItems: [putEventItem(tables.outbox, newEvent('SubscriptionRenewalApproaching', 'subscription', s.subscriptionId, {
        ownerId, provider: s.provider, renewalDate: s.renewalDate, amountMinor: s.amountMinor,
      }))],
    }));
    // eslint-disable-next-line no-await-in-loop
    await sendNotification({
      channel: 'webhook', toUserId: ownerId,
      subject: `${s.provider} renews ${s.renewalDate}`,
      body: `${s.provider} charges ${(s.amountMinor / 100).toFixed(2)} on ${s.renewalDate}. Cancel within 72h if unwanted.`,
    });
    emitted.push(s.subscriptionId);
  }
  return { scanned: due.length, emitted };
}

const PROVIDER_GUIDES = {
  netflix: {
    provider: 'Netflix',
    steps: ['Open netflix.com > Account', 'Membership & Billing > Cancel Membership', 'Confirm; access runs to period end'],
    portal: 'https://www.netflix.com/cancelplan',
    concierge: false,
  },
  spotify: {
    provider: 'Spotify',
    steps: ['Account page > Your plan > Change plan', 'Cancel Premium > confirm'],
    portal: 'https://support.spotify.com/article/cancel-premium/',
    concierge: false,
  },
  youtube: {
    provider: 'YouTube Premium',
    steps: ['Paid memberships > Manage membership > Deactivate'],
    portal: 'https://support.google.com/youtube/answer/6306276',
    concierge: false,
  },
};

function cancellationGuide(provider) {
  const key = String(provider || '').trim().toLowerCase();
  const guide = PROVIDER_GUIDES[key];
  if (!guide) return { provider, supported: false, steps: [], portal: null, concierge: false };
  return { ...guide, supported: true };
}

async function requestConcierge({ doc, tables }, { requesterId, subscriptionId, authorization }) {
  const { subscription } = await getSubscription({ doc, tables }, { requesterId, subscriptionId });
  if (subscription.ownerId !== requesterId) throw forbidden('only the owner authorizes concierge');
  if (!authorization || typeof authorization !== 'string' || authorization.trim().length < 10) {
    throw badRequest('bad-auth', 'explicit authorization text required');
  }
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  await doc.send(new UpdateCommand({
    TableName: tables.subscriptions, Key: { subscriptionId },
    UpdateExpression: 'SET #st = :p, conciergeAuth = :a, updatedAt = :u',
    ConditionExpression: '#st = :active',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':p': 'PENDING_CONCIERGE', ':active': 'ACTIVE', ':a': authorization.trim(), ':u': nowIso() },
  })).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') throw badRequest('bad-status', 'not in cancellable state');
    throw err;
  });
  const guide = cancellationGuide(subscription.provider);
  if (guide.concierge) {
    await doc.send(new TransactWriteCommand({
      TransactItems: [putEventItem(tables.outbox, newEvent('CancellationRequested', 'subscription', subscriptionId, {
        by: requesterId, provider: subscription.provider,
      }))],
    }));
  }
  return { subscriptionId, status: 'PENDING_CONCIERGE', providerSupported: guide.concierge };
}

module.exports = { sendNotification, scanRenewals, cancellationGuide, requestConcierge, PROVIDER_GUIDES, signPayload };
