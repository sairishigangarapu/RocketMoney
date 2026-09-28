'use strict';
/* Auth verification unit tests (TC-AUTH-01): real RSA + real JWT + local JWKS server.
 * No database, no network beyond localhost. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { requireUser } = require('../src/auth');

const KID = 'test-kid-1';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ format: 'pem', type: 'pkcs8' });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

let server;
let jwksUrl;
before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [JWK] }));
  });
  await new Promise((r) => server.listen(0, r));
  jwksUrl = `http://localhost:${server.address().port}/.well-known/jwks.json`;
});
after(() => server.close());

function tokenFor(sub, kid = KID, extra = {}) {
  return jwt.sign({ sub, ...extra }, PRIVATE_PEM, { algorithm: 'RS256', keyid: kid, expiresIn: '1h' });
}

test('valid Bearer JWT verifies to the sub identity', async () => {
  process.env.WORKOS_JWKS_URL = jwksUrl;
  try {
    const u = await requireUser({ headers: { authorization: `Bearer ${tokenFor('u-jwt-1')}` } });
    assert.equal(u.workosUserId, 'u-jwt-1');
    assert.equal(u.testMode, false);
  } finally {
    delete process.env.WORKOS_JWKS_URL;
  }
});

test('tampered token, unknown kid, and missing subject are 401', async () => {
  process.env.WORKOS_JWKS_URL = jwksUrl;
  try {
    const good = tokenFor('u-jwt-1');
    const tampered = good.slice(0, -2) + (good.endsWith('aa') ? 'bb' : 'aa');
    await assert.rejects(requireUser({ headers: { authorization: `Bearer ${tampered}` } }), (e) => e.statusCode === 401);
    await assert.rejects(requireUser({ headers: { authorization: `Bearer ${tokenFor('u-x', 'unknown-kid')}` } }), (e) => e.statusCode === 401);
    const nosub = jwt.sign({}, PRIVATE_PEM, { algorithm: 'RS256', keyid: KID, expiresIn: '1h' });
    await assert.rejects(requireUser({ headers: { authorization: `Bearer ${nosub}` } }), (e) => e.statusCode === 401);
  } finally {
    delete process.env.WORKOS_JWKS_URL;
  }
});

test('Bearer without JWKS configured is 401, never open', async () => {
  delete process.env.WORKOS_JWKS_URL;
  delete process.env.ALLOW_TEST_AUTH;
  await assert.rejects(
    requireUser({ headers: { authorization: 'Bearer anything.at.all' } }),
    (e) => e.statusCode === 401,
  );
});
