'use strict';
/* Request authentication seam.
 * Production path (WorkOS session verification) lands with M4c hardening; until then the API
 * refuses authenticated routes unless the explicitly test-only header seam is enabled:
 *   ALLOW_TEST_AUTH=true  +  x-test-user: <workosUserId>
 * The seam never activates by default, so a misconfigured deploy fails closed (501), not open.
 */
const { unauthorized } = require('./errors');

function requireUser(req) {
  if (process.env.ALLOW_TEST_AUTH === 'true') {
    const userId = req.headers['x-test-user'];
    if (!userId || typeof userId !== 'string') throw unauthorized('x-test-user header required');
    return { workosUserId: userId, testMode: true };
  }
  const err = new Error('authentication not configured (WorkOS session verification lands in M4c)');
  err.statusCode = 501;
  err.code = 'auth-not-configured';
  throw err;
}

module.exports = { requireUser };
