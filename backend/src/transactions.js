'use strict';
/* Transaction CSV import (FR-002 manual path; live Plaid sync is a stretch adapter).
 * Expected header: date,merchant,amount  (amount in rupees, may be negative for refunds).
 * Idempotent per (user, source, batch, row): txnId = sha1(source|batch|rowIndex|raw) so a
 * re-uploaded file imports zero new rows. Raw banking credentials never appear here (NFR-001).
 */
const crypto = require('node:crypto');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { badRequest } = require('./errors');
const { nowIso } = require('./ids');

function normalizeMerchant(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseCSV(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw badRequest('bad-csv', 'CSV needs a header plus at least one row');
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const need = ['date', 'merchant', 'amount'];
  for (const c of need) {
    if (!header.includes(c)) throw badRequest('bad-csv', `missing column: ${c}`);
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return lines.slice(1).map((line, i) => {
    const cells = line.split(',').map((c) => c.trim());
    const amount = Number.parseFloat(cells[idx.amount]);
    if (!cells[idx.date] || !cells[idx.merchant] || !Number.isFinite(amount)) {
      throw badRequest('bad-csv', `invalid row ${i + 2}`);
    }
    return { date: cells[idx.date], merchant: cells[idx.merchant], amountMinor: Math.round(amount * 100) };
  });
}

async function importTransactions({ doc, tables }, { userId, source, batchId, csvText }) {
  if (!source) throw badRequest('bad-source', 'source required');
  if (!batchId) throw badRequest('bad-batch', 'batchId required');
  const rows = parseCSV(csvText);
  let imported = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const txnId = crypto.createHash('sha1').update(`${source}|${batchId}|${i}|${r.date}|${r.merchant}|${r.amountMinor}`).digest('hex');
    // eslint-disable-next-line no-await-in-loop
    await doc.send(new PutCommand({
      TableName: tables.transactions,
      Item: {
        workosUserId: userId, txnId, source, importBatchId: batchId,
        merchantRaw: r.merchant, merchantNorm: normalizeMerchant(r.merchant),
        amountMinor: r.amountMinor, currency: 'INR', bookedAt: r.date, createdAt: nowIso(),
      },
      ConditionExpression: 'attribute_not_exists(workosUserId)',
    })).then(() => { imported += 1; }).catch((err) => {
      if (err.name === 'ConditionalCheckFailedException') { skipped += 1; return; }
      throw err;
    });
  }
  return { imported, skipped, total: rows.length };
}

module.exports = { parseCSV, normalizeMerchant, importTransactions };
