/**
 * Headless proof that the queue cannot create a duplicate.
 *
 * This is not a mock of the app's logic - it imports the same
 * src/lib/sync-core.mjs the browser runs. The only things swapped out are the
 * two things a browser owns: IndexedDB becomes a JSON file, and fetch talks to
 * the mock server directly instead of through the Next dev proxy.
 *
 * The interesting part is the crash. `run --crash` fires a request and then
 * kills the process while it is still in flight, exactly as a force-quit would.
 * The report is left on disk marked 'sending'. The next run finds it, puts it
 * back in the queue and resends it with the SAME client_report_id - and the
 * server answers 409 instead of storing a second copy.
 *
 * Usage:
 *   node test/harness.mjs seed [n]
 *   node test/harness.mjs run [--crash]
 *   node test/harness.mjs report
 *
 * Or just: npm run verify
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  applyOutcome,
  classify,
  newItem,
  pickNext,
  recoverInterrupted,
  wireBody,
  isPending,
  REQUEST_TIMEOUT_MS,
  NO_ANSWER,
} from '../src/lib/sync-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '.queue-state.json');
const BASE = process.env.MOCK_API_URL || 'http://localhost:4000';

/* ---------------------------------------------------------------- store -- */
/* Stands in for IndexedDB. Written synchronously so a hard exit cannot lose
   a write that already returned - same durability promise IndexedDB gives. */

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : []);
const save = (items) => writeFileSync(STATE, JSON.stringify(items, null, 2));

function upsert(item) {
  const items = load();
  const i = items.findIndex((x) => x.client_report_id === item.client_report_id);
  if (i === -1) items.push(item);
  else items[i] = item;
  save(items);
}

/* ----------------------------------------------------------------- http -- */
/* Same contract as src/lib/api.ts: never throws, normalises "we never heard
   back" into status 0 so sync-core can decide what that means. */

async function postReport(item) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(BASE + '/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wireBody(item)),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    return {
      status: NO_ANSWER,
      body: { reason: err?.name === 'AbortError' ? 'timed out with no answer' : 'connection dropped' },
      retryAfter: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------- commands -- */

const REPORTS = [
  ['Al-Madina Store, Korangi', 'Two shelves of expired stock still on sale', 'Pull stock, reprint date labels'],
  ['Bismillah Kiryana, Lyari', 'Freezer at +4C, ice cream melted', 'Engineer visit within 24h'],
  ['New Sunrise Mart, Malir', 'Competitor display blocking our shelf', 'Escalate to territory manager'],
  ['Rehman General Store, Orangi', 'No price cards on the new SKU', 'Deliver price cards on next run'],
  ['City Mart, Gulshan', 'Stock-out on 500ml since Tuesday', 'Emergency replenishment'],
  ['Khan Brothers, Landhi', 'Damaged cartons in back store', 'Credit note and uplift'],
];

function seed(n) {
  if (existsSync(STATE)) unlinkSync(STATE);
  const now = Date.now();
  const items = REPORTS.slice(0, n).map((r, i) =>
    // Each report gets its id here and only here. Nothing downstream mints another.
    newItem(
      { outlet_name: r[0], finding: r[1], action_needed: r[2], lat: 24.8607, lng: 67.0011 },
      randomUUID(),
      now + i
    )
  );
  save(items);
  console.log(`seeded ${items.length} reports`);
}

async function run({ crash }) {
  // Recovery first: anything left 'sending' by a previous process never got an
  // answer, so it goes back in the queue under its original id.
  const recovered = recoverInterrupted(load(), Date.now());
  for (const item of recovered) {
    console.log(`  recovered ${short(item)} - was interrupted mid-send, requeuing`);
    upsert(item);
  }

  let sent = 0;

  for (;;) {
    const now = Date.now();
    const item = pickNext(load(), now);

    if (!item) {
      const pending = load().filter(isPending);
      if (!pending.length) break;
      await sleep(400); // waiting out a backoff
      continue;
    }

    // Step 1: record the intent, durably, before touching the network.
    const sending = { ...item, status: 'sending' };
    upsert(sending);

    if (crash && sent === 1) {
      // Force-quit, mid-flight. Fire the request and die without ever reading
      // the answer. The server will store this report; our disk will not know.
      console.log(`  ${short(item)} attempt ${item.attempts + 1} -> firing, then killing the process`);
      postReport(sending).catch(() => {});
      await sleep(8000); // long enough for the server to have stored it
      console.log('  *** process killed while the request was in flight ***');
      process.exit(7);
    }

    const result = await postReport(sending);
    const outcome = classify(result);
    const next = applyOutcome(sending, outcome, Date.now());
    upsert(next);

    const detail =
      outcome.kind === 'accepted'
        ? `accepted${outcome.deduped ? ' via 409 - server already had it, NOT stored twice' : ''} (${next.server_report_id})`
        : outcome.kind === 'permanent'
          ? `rejected for good: ${outcome.reason}`
          : `${outcome.reason} - retrying in ${Math.round((next.next_attempt_at - Date.now()) / 100) / 10}s`;

    console.log(`  ${short(item)} attempt ${next.attempts} [${result.status || 'no answer'}] ${detail}`);
    if (next.status === 'sent') sent++;
  }

  const items = load();
  console.log(
    `run finished - ${items.filter((i) => i.status === 'sent').length} confirmed, ` +
      `${items.filter((i) => i.status === 'rejected').length} rejected, ` +
      `${items.filter(isPending).length} still pending`
  );
}

const short = (i) => i.payload.outlet_name.split(',')[0].padEnd(26);

async function report() {
  const res = await fetch(BASE + '/v1/_debug/count');
  const body = await res.json();
  const local = load();

  console.log('\n--- server ------------------------------------------------');
  console.log(JSON.stringify(body, null, 2));

  console.log('\n--- this device -------------------------------------------');
  for (const i of local) {
    console.log(
      `  ${i.status.padEnd(9)} ${i.attempts} attempt(s)  ${i.deduped ? 'deduped ' : '        '} ${i.payload.outlet_name}`
    );
  }

  const allSettled = local.every((i) => !isPending(i));
  const noneLost = local.filter((i) => i.status === 'sent').length === body.reports_stored;
  const pass = body.duplicates_created === 0 && allSettled && noneLost;

  console.log('\n--- verdict -----------------------------------------------');
  console.log(`  duplicates_created ......... ${body.duplicates_created}`);
  console.log(`  reports stored on server ... ${body.reports_stored}`);
  console.log(`  confirmed on this device ... ${local.filter((i) => i.status === 'sent').length}`);
  console.log(`  409s the server had to send  ${body.conflicts_409}  (each one is a duplicate that did not happen)`);
  console.log(`  save-then-drop hits ........ ${body.save_then_drop}`);
  console.log(`  ${pass ? 'PASS' : 'FAIL'} - ${body.VERDICT}\n`);

  process.exit(pass ? 0 : 1);
}

/* ------------------------------------------------------------------ main -- */

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'seed') seed(Number(rest[0]) || REPORTS.length);
else if (cmd === 'run') await run({ crash: rest.includes('--crash') });
else if (cmd === 'report') await report();
else {
  console.error('usage: node test/harness.mjs seed|run [--crash]|report');
  process.exit(2);
}
