'use client';

import * as db from './db';
import { postReport } from './api';
import {
  applyOutcome,
  classify,
  newItem,
  pickNext,
  recoverInterrupted,
  wakeForReconnect,
} from './sync-core.mjs';
import type { QueueItem, ReportInput } from './sync-core.mjs';

/**
 * The outbox: the browser-side wiring around the pure logic in sync-core.mjs.
 *
 * Order of operations when sending one item, which is the part that matters:
 *
 *   1. mark it 'sending' and WRITE THAT TO DISK first
 *   2. POST it
 *   3. write the outcome to disk
 *
 * If the app dies between 1 and 3 - the worker force-quits, the phone is out
 * of battery, the tab is closed - the item is found in 'sending' on next
 * launch and put back in the queue. It is resent with the same
 * client_report_id, so the server answers 409 rather than storing it twice.
 */

type Listener = (items: QueueItem[]) => void;

let listeners: Listener[] = [];
let cache: QueueItem[] = [];
let started = false;
let draining = false;
let ticker: ReturnType<typeof setInterval> | null = null;

const byAge = (a: QueueItem, b: QueueItem) => a.created_at - b.created_at;

function emit() {
  for (const l of listeners) l(cache);
}

async function refresh() {
  cache = (await db.readAll()).sort(byAge);
  emit();
}

export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  listener(cache);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function snapshot(): QueueItem[] {
  return cache;
}

/** The one and only place a client_report_id is minted. */
function mintId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'cid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
}

/**
 * Accept a report from the form. Returns only after the report is durably on
 * disk - the worker is never told "saved" before it is actually saved.
 */
export async function enqueue(input: ReportInput): Promise<QueueItem> {
  const now = Date.now();
  const item = newItem(input, mintId(), now);
  await db.write(item);
  await refresh();
  void drain();
  return item;
}

/**
 * Only one drain runs at a time, across tabs as well as within one.
 * Two tabs open on the same phone would otherwise both pick the same queued
 * item and send it twice with the same id - the server would dedupe it, but
 * the second request is wasted work on a connection that is already bad.
 */
async function withLock(fn: () => Promise<void>): Promise<void> {
  const locks = (navigator as unknown as { locks?: LockManager }).locks;
  if (locks?.request) {
    await locks.request('field-reports-outbox', { ifAvailable: true }, async (lock) => {
      if (!lock) return; // another tab already has it
      await fn();
    });
    return;
  }
  await fn();
}

export async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    await withLock(async () => {
      for (;;) {
        // The device itself says there is no network: do not send, and do not
        // spend an attempt. Attempts fired into a dead network grow the backoff,
        // so the first real 503 after reconnecting waited 30s instead of 1s -
        // measured at 90s to sync three reports. The 'online' event restarts
        // this loop. navigator.onLine can only skip a send here; it never
        // decides whether a report was delivered.
        if (!navigator.onLine) return;

        const item = pickNext(cache, Date.now());
        if (!item) return;

        // Step 1: record the intent before doing anything over the network.
        const sending: QueueItem = { ...item, status: 'sending' };
        await db.write(sending);
        await refresh();

        // Step 2: the attempt itself. Never throws - postReport normalises
        // network failures into status 0.
        const result = await postReport(sending);

        // Step 3: record what we learned.
        const next = applyOutcome(sending, classify(result), Date.now());
        await db.write(next);
        await refresh();
      }
    });
  } finally {
    draining = false;
  }
}

/** Network is back: stop waiting out offline backoff, send now. */
async function onReconnect(): Promise<void> {
  const woken = wakeForReconnect(cache, Date.now());
  for (const item of woken) await db.write(item);
  if (woken.length) await refresh();
  void drain();
}

export async function start(): Promise<void> {
  if (started) return;
  started = true;

  await refresh();

  const interrupted = recoverInterrupted(cache, Date.now());
  for (const item of interrupted) await db.write(item);
  if (interrupted.length) await refresh();

  // navigator.onLine is a hint, not a fact - it goes true on a captive portal
  // and on a wifi network with no upstream. We use it to trigger a drain, never
  // to decide whether a report was delivered. Only the server decides that.
  window.addEventListener('online', () => void onReconnect());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void drain();
  });

  // Backoff means an item can become due with nothing else happening, so a
  // slow tick covers the gap between events.
  ticker = setInterval(() => void drain(), 1500);

  void drain();
}

export function stop(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  started = false;
}

/** Drops settled rows. Pending work is never removable from the UI. */
export async function clearSettled(): Promise<void> {
  const settled = cache.filter((i) => i.status === 'sent' || i.status === 'rejected');
  for (const item of settled) await db.remove(item.client_report_id);
  await refresh();
}

export async function retryNow(clientReportId: string): Promise<void> {
  const item = cache.find((i) => i.client_report_id === clientReportId);
  if (!item || item.status === 'sent') return;
  await db.write({ ...item, status: 'queued', next_attempt_at: Date.now() });
  await refresh();
  void drain();
}
