'use strict';
/* Request authentication (SEC-002).
 * Chain (first match wins):
 *  1. Bearer JWT verified against WORKOS_JWKS_URL (real WorkOS sessions). The `sub`
 *     claim is the WorkOS user id. Any verification failure -> 401.
 *  2. DEV-ONLY seam: ALLOW_TEST_AUTH=true + x-test-user header. Never on in prod.
 *  3. Otherwise 501 auth-not-configured: fail closed, never open.
 */
const jwt = require('jsonwebtoken');
const { JwksClient } = require('jwks-rsa');
const { unauthorized } = require('./errors');

let jwksClient = null;
function getJwksClient() {
  const url = process.env.WORKOS_JWKS_URL;
  if (!url) return null;
  if (!jwksClient || jwksClient.jwksUri !== url) {
    jwksClient = new JwksClient({ jwksUri: url, cache: true, rateLimit: true });
    jwksClient.jwksUri = url;
  }
  return jwksClient;
}

async function verifyBearer(token) {
  const client = getJwksClient();
  if (!client) return null; // JWT path not configured
  let header;
  try {
    const decoded = jwt.decode(token, { complete: true });
    header = decoded && decoded.header;
  } catch {
    throw unauthorized('malformed bearer token');
  }
  if (!header || !header.kid) throw unauthorized('bearer token has no kid');
  let key;
  try {
    key = await client.getSigningKey(header.kid);
  } catch {
    throw unauthorized('unknown token signer');
  }
  try {
    const payload = jwt.verify(token, key.getPublicKey(), { algorithms: ['RS256'] });
    if (!payload || !payload.sub) throw unauthorized('token has no subject');
    return { workosUserId: payload.sub, testMode: false };
  } catch (err) {
    if (err.statusCode) throw err;
    throw unauthorized(`token verification failed: ${err.message}`);
  }
}

async function requireUser(req) {
  const authz = req.headers && req.headers.authorization;
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    const verified = await verifyBearer(authz.slice('Bearer '.length).trim());
    if (verified) return verified;
    throw unauthorized('bearer token present but JWT verification is not configured');
  }
  if (process.env.ALLOW_TEST_AUTH === 'true') {
    const userId = req.headers['x-test-user'];
    if (!userId || typeof userId !== 'string') throw unauthorized('x-test-user header required');
    return { workosUserId: userId, testMode: true };
  }
  const err = new Error('authentication not configured (set WORKOS_JWKS_URL or ALLOW_TEST_AUTH=true for local dev)');
  err.statusCode = 501;
  err.code = 'auth-not-configured';
  throw err;
}

module.exports = { requireUser };
