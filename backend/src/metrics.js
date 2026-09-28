'use strict';
/* Burn-rate dashboard figures (FR-008). Personal total = owned ACTIVE subscriptions.
 * Room figures = the room's linked subscription (if any) + the requester's outstanding
 * member balance magnitude. All from materialized rows — no raw-transaction rescan (NFR-002).
 */
const { listMySubscriptions } = require('./subscriptions');
const { listRooms, netBalanceForUser } = require('./rooms');

async function dashboard({ doc, tables }, { userId }) {
  const personal = await listMySubscriptions({ doc, tables }, { userId });
  const personalMinor = personal.reduce((s, x) => s + (Number(x.amountMinor) || 0), 0);
  const memberships = await listRooms({ doc, tables }, { userId });
  const roomRows = [];
  for (const m of memberships) {
    let outstanding = 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      outstanding = Math.abs(await netBalanceForUser(doc, tables, m.roomId, userId));
    } catch {
      outstanding = 0; // balances table empty pre-#7 data: treat as settled
    }
    roomRows.push({ roomId: m.roomId, name: m.name, role: m.myRole, status: m.status, outstandingMinor: outstanding });
  }
  return {
    personalMinor,
    personalCount: personal.length,
    rooms: roomRows,
    totalOutstandingMinor: roomRows.reduce((s, r) => s + r.outstandingMinor, 0),
  };
}

module.exports = { dashboard };
