/**
 * One command that proves the claim.
 *
 *   1. reset the mock server
 *   2. queue six reports
 *   3. drain until the process is killed mid-send (a force-quit)
 *   4. relaunch and drain to completion
 *   5. read GET /v1/_debug/count and check duplicates_created is 0
 *
 * Step 3 is the point. The report that was in flight when the process died was
 * stored by the server; this device never heard so. Step 4 resends it under the
 * same client_report_id and gets a 409 back, so it is confirmed rather than
 * stored again.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MOCK_API_URL || 'http://localhost:4000';

function step(label) {
  console.log(`\n=== ${label} ${'='.repeat(Math.max(0, 54 - label.length))}`);
}

function node(args) {
  return spawnSync(process.execPath, [join(HERE, 'harness.mjs'), ...args], {
    stdio: 'inherit',
    env: process.env,
  });
}

try {
  await fetch(BASE + '/v1/_debug/reset', { method: 'POST' });
} catch {
  console.error(`\nCannot reach the mock server at ${BASE}.`);
  console.error('Start it in another terminal first:  npm run mock\n');
  process.exit(2);
}

step('1/4  reset server, queue six reports');
node(['seed']);

step('2/4  drain, then force-quit mid-send');
node(['run', '--crash']);

step('3/4  relaunch and finish the queue');
node(['run']);

step('4/4  what the assessment reads');
const res = node(['report']);
process.exit(res.status ?? 1);
