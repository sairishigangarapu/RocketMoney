'use strict';
/* M0 smoke tests: fail-fast startup + boot/health/stub contract + graceful shutdown.
 * Run: npm test (from backend/). Requires: fastify in node_modules.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const BASE_ENV = {
  PATH: process.env.PATH,
  WORKOS_API_KEY: 'test',
  AWS_REGION: 'ap-south-1',
  DYNAMODB_TABLE_PREFIX: 'rm-test',
};

function spawnServer(extraEnv, port) {
  return spawn(process.execPath, [SERVER], {
    env: { ...BASE_ENV, ...extraEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForOutput(child, needle, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for: ${needle}\n${buf}`)), timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes(needle)) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`exited before: ${needle}\n${buf}`));
    });
  });
}

test('fail-fast: missing env exits 1 naming (not leaking) the missing keys', async () => {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH } });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 1);
  assert.match(err, /missing-required-env/);
  assert.match(err, /WORKOS_API_KEY/);
});

test('boot: /health 200, stubs 501, SIGTERM drains with exit 0', async () => {
  const child = spawnServer({}, 38993);
  try {
    await waitForOutput(child, '"outcome":"listening"');
    const health = await (await fetch('http://localhost:38993/health')).json();
    assert.equal(health.status, 'ok');
    const stub = await fetch('http://localhost:38993/api/rooms', { method: 'POST' });
    assert.equal(stub.status, 501);
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
  } finally {
    child.kill('SIGKILL');
  }
});
