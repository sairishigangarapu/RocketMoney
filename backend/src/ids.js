'use strict';
/* Opaque ID + token generation. Invitation tokens are 256-bit CSPRNG, base64url (SEC-004).
 * Entity IDs are prefixed random hex (rm_/ex_/st_/ev_/in_); sortability is not required in MVP.
 */
const crypto = require('node:crypto');

function entityId(prefix) {
  return `${prefix}${crypto.randomBytes(13).toString('hex')}`;
}
function inviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function lockOwner() {
  return crypto.randomUUID();
}
function nowIso() {
  return new Date().toISOString();
}
function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

module.exports = { entityId, inviteToken, lockOwner, nowIso, nowEpoch };
