'use strict';
/* Anonymized aggregate reporting (FR-005). Output contains provider totals and counts ONLY:
 * no user ids, emails, names, tokens, or row-level data. A test asserts the PII absence.
 */
const { ScanCommand } = require('@aws-sdk/lib-dynamodb');

async function activeSubscriptions({ doc, tables }) {
  const out = [];
  let key;
  do {
    // eslint-disable-next-line no-await-in-loop
    const s = await doc.send(new ScanCommand({
      TableName: tables.subscriptions,
      FilterExpression: '#st = :a',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':a': 'ACTIVE' },
      ExclusiveStartKey: key,
    }));
    out.push(...(s.Items || []));
    key = s.LastEvaluatedKey;
  } while (key);
  return out;
}

function aggregate(subs) {
  const byProvider = new Map();
  for (const s of subs) {
    const cur = byProvider.get(s.provider) || { provider: s.provider, count: 0, monthlyMinor: 0 };
    cur.count += 1;
    cur.monthlyMinor += Number(s.amountMinor) || 0;
    byProvider.set(s.provider, cur);
  }
  return [...byProvider.values()].sort((a, b) => b.monthlyMinor - a.monthlyMinor);
}

function toCSV(rows) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = ['provider,subscriptions,monthly_minor,monthly_rupees'];
  for (const r of rows) lines.push([esc(r.provider), r.count, r.monthlyMinor, (r.monthlyMinor / 100).toFixed(2)].join(','));
  return `${lines.join('\n')}\n`;
}

function toPDF(rows) {
  // Lazy-require so unit tests that only touch CSV pay nothing.
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const chunks = [];
    const pdf = new PDFDocument({ info: { Title: 'RocketMoney aggregate burn-rate', Creator: 'RocketMoney' } });
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.fontSize(18).text('RocketMoney — aggregate monthly burn-rate', { underline: true });
    pdf.moveDown();
    pdf.fontSize(10).text('Anonymized aggregate. No personal data.');
    pdf.moveDown();
    for (const r of rows) {
      pdf.fontSize(12).text(`${r.provider}: ${r.count} subscription(s), Rs ${(r.monthlyMinor / 100).toFixed(2)}/mo`);
    }
    pdf.end();
  });
}

async function buildReport({ doc, tables }, { format }) {
  const rows = aggregate(await activeSubscriptions({ doc, tables }));
  if (format === 'csv') return { contentType: 'text/csv', body: toCSV(rows) };
  if (format === 'pdf') return { contentType: 'application/pdf', body: await toPDF(rows) };
  const err = new Error('format must be csv or pdf');
  err.statusCode = 400; err.code = 'bad-format'; throw err;
}

module.exports = { aggregate, toCSV, toPDF, buildReport };
