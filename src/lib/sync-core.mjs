// @ts-check
/**
 * Pure decision logic for the outbox.
 *
 * Nothing in this file touches the network, the DOM, IndexedDB or React.
 * Every function is pure, so the exact code that decides what happens in the
 * browser is the same code the headless harness in /test runs. Plain JS (with
 * JSDoc types) so Node can import it directly on Node 18+ with no build step.
 *
 * The single rule this file exists to enforce:
 *
 *   A report gets ONE client_report_id, generated once when the worker hits
 *   Submit. Every retry of that report resends that same id. The server
 *   promises it will not store a second copy of an id it has already seen -
 *   it answers 409 with the original report_id instead. So a retry after a
 *   dropped connection is safe: worst case the server says "already have it",
 *   which we treat as success, not as an error.
 */

export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30000;
export const REQUEST_TIMEOUT_MS = 20000;

/** Our own status code for "the connection died before we heard anything". */
export const NO_ANSWER = 0;

/** last_error for a 429, so a reconnect does not cut short a wait the server asked for. */
export const RATE_LIMITED = 'rate limited by server';

/**
 * @typedef {Object} ReportPayload
 * @property {string} outlet_name
 * @property {string} finding
 * @property {string} action_needed
 * @property {string} captured_at   ISO-8601, stamped once at submit time
 * @property {number} lat
 * @property {number} lng
 */

/**
 * @typedef {'queued'|'sending'|'sent'|'rejected'} QueueStatus
 */

/**
 * @typedef {Object} QueueItem
 * @property {string} client_report_id  generated once at enqueue; the primary key
 * @property {ReportPayload} payload
 * @property {QueueStatus} status
 * @property {number} attempts
 * @property {number} next_attempt_at   epoch ms
 * @property {string|null} last_error
 * @property {string|null} server_report_id
 * @property {boolean} deduped          server told us it already had this one
 * @property {number} created_at
 * @property {number|null} settled_at
 */

/**
 * @typedef {Object} HttpResult
 * @property {number} status      HTTP status, or NO_ANSWER (0) if we never heard back
 * @property {any} body
 * @property {string|null} retryAfter
 */

/**
 * @typedef {{kind:'accepted', report_id:string|null, deduped:boolean}
 *         | {kind:'permanent', reason:string}
 *         | {kind:'retry', reason:string, retryAfterMs?:number}} Outcome
 */

/**
 * Turn one send attempt into a decision.
 * @param {HttpResult} result
 * @returns {Outcome}
 */
export function classify(result) {
  const status = result.status;
  const body = result.body || {};

  // ---------------------------------------------------------------------
  // The case the whole task is about.
  //
  // status 0   - fetch threw: offline, timed out, or the server accepted the
  //              report and then killed the socket before answering.
  // status 599 - our dev proxy's way of saying the same thing.
  //
  // We genuinely do not know whether it was stored. We do NOT guess. We retry
  // with the same client_report_id and let the server tell us.
  // ---------------------------------------------------------------------
  if (status === NO_ANSWER || status === 599) {
    return { kind: 'retry', reason: body.reason || 'no answer from server' };
  }

  if (status === 200 || status === 201) {
    return { kind: 'accepted', report_id: body.report_id ?? null, deduped: false };
  }

  // Not an error. The server is telling us it already has this exact report
  // and handing back the original id. This is a retry that correctly did not
  // create a duplicate.
  if (status === 409) {
    return { kind: 'accepted', report_id: body.report_id ?? null, deduped: true };
  }

  if (status === 429) {
    const secs = Number(result.retryAfter);
    return {
      kind: 'retry',
      reason: RATE_LIMITED,
      retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined,
    };
  }

  if (status >= 500) {
    return { kind: 'retry', reason: 'server error ' + status };
  }

  // 400 / 413 / 404 and friends. Retrying cannot fix a malformed report, and
  // hammering the server with one is worse than telling the worker plainly.
  return {
    kind: 'permanent',
    reason: body.error ? status + ' ' + body.error : 'rejected by server (' + status + ')',
  };
}

/**
 * Exponential backoff with jitter, capped. Jitter matters: without it, a queue
 * that went offline retries every item on the same tick when the network returns.
 * @param {number} attempts number of attempts made so far (1 = first failure)
 * @param {() => number} [random]
 * @returns {number} milliseconds to wait
 */
export function backoffMs(attempts, random = Math.random) {
  const exponent = Math.max(0, attempts - 1);
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, exponent));
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

/**
 * Fold a decision back into the queue item. Never mutates.
 * @param {QueueItem} item
 * @param {Outcome} outcome
 * @param {number} now
 * @param {() => number} [random]
 * @returns {QueueItem}
 */
export function applyOutcome(item, outcome, now, random = Math.random) {
  const attempts = item.attempts + 1;

  if (outcome.kind === 'accepted') {
    return {
      ...item,
      attempts,
      status: 'sent',
      server_report_id: outcome.report_id,
      deduped: outcome.deduped,
      last_error: null,
      next_attempt_at: 0,
      settled_at: now,
    };
  }

  if (outcome.kind === 'permanent') {
    return {
      ...item,
      attempts,
      status: 'rejected',
      last_error: outcome.reason,
      next_attempt_at: 0,
      settled_at: now,
    };
  }

  const wait = typeof outcome.retryAfterMs === 'number'
    ? outcome.retryAfterMs
    : backoffMs(attempts, random);

  return {
    ...item,
    attempts,
    status: 'queued',
    last_error: outcome.reason,
    next_attempt_at: now + wait,
    settled_at: null,
  };
}

/**
 * The next item due to be sent, oldest first. Returns null when nothing is due.
 * One at a time, deliberately: it keeps ordering obvious and stops the queue
 * from stampeding a server that is already telling us it is rate limited.
 * @param {QueueItem[]} items
 * @param {number} now
 * @returns {QueueItem|null}
 */
export function pickNext(items, now) {
  let best = null;
  for (const item of items) {
    if (item.status !== 'queued') continue;
    if (item.next_attempt_at > now) continue;
    if (!best || item.created_at < best.created_at) best = item;
  }
  return best;
}

/**
 * Items left in 'sending' when the app starts were interrupted mid-flight -
 * the tab was closed, the phone was force-quit, the process died. We never
 * heard an answer, so they go back in the queue. Because the client_report_id
 * is unchanged, resending them cannot create a duplicate.
 * @param {QueueItem[]} items
 * @param {number} now
 * @returns {QueueItem[]} the items that need rewriting
 */
export function recoverInterrupted(items, now) {
  return items
    .filter((i) => i.status === 'sending')
    .map((i) => ({
      ...i,
      status: /** @type {QueueStatus} */ ('queued'),
      // That interrupted send was a real attempt against the server, so it
      // counts as one. Otherwise an app that dies on every launch would retry
      // forever with no backoff at all.
      attempts: i.attempts + 1,
      next_attempt_at: now,
      last_error: 'app closed mid-send - retrying',
    }));
}

/**
 * The device says the network is back. Items sitting out a backoff were mostly
 * waiting because we were offline - after a few failed tries that wait is up
 * to 30s, which is 30s of a worker staring at a queue that should be moving.
 * So they become due now. A 429 wait is left alone: the server asked for it.
 *
 * Only a hint, like navigator.onLine itself. If the network is not really back,
 * the send fails and the item goes straight back into backoff.
 * @param {QueueItem[]} items
 * @param {number} now
 * @returns {QueueItem[]} the items that need rewriting
 */
export function wakeForReconnect(items, now) {
  return items
    .filter((i) => i.status === 'queued' && i.next_attempt_at > now && i.last_error !== RATE_LIMITED)
    .map((i) => ({ ...i, next_attempt_at: now }));
}

/**
 * Build a fresh queue item. The id is passed in rather than generated here so
 * this file stays pure and the caller owns the one place an id is minted.
 * @param {Omit<ReportPayload,'captured_at'>} input
 * @param {string} clientReportId
 * @param {number} now
 * @returns {QueueItem}
 */
export function newItem(input, clientReportId, now) {
  return {
    client_report_id: clientReportId,
    payload: {
      outlet_name: input.outlet_name.trim(),
      finding: input.finding.trim(),
      action_needed: input.action_needed.trim(),
      captured_at: new Date(now).toISOString(),
      lat: input.lat,
      lng: input.lng,
    },
    status: 'queued',
    attempts: 0,
    next_attempt_at: now,
    last_error: null,
    server_report_id: null,
    deduped: false,
    created_at: now,
    settled_at: null,
  };
}

/**
 * The body we put on the wire. The id travels with every single attempt.
 * @param {QueueItem} item
 */
export function wireBody(item) {
  return { client_report_id: item.client_report_id, ...item.payload };
}

/**
 * Client-side validation, so we never spend a queue slot on a report the
 * server is guaranteed to 400.
 * @param {{outlet_name:string, finding:string, action_needed:string, lat:unknown, lng:unknown}} input
 * @returns {Record<string,string>} field -> message, empty when valid
 */
export function validate(input) {
  /** @type {Record<string,string>} */
  const errors = {};
  if (!input.outlet_name || !input.outlet_name.trim()) errors.outlet_name = 'Required';
  if (!input.finding || !input.finding.trim()) errors.finding = 'Required';
  if (!input.action_needed || !input.action_needed.trim()) errors.action_needed = 'Required';
  if (typeof input.lat !== 'number' || !Number.isFinite(input.lat)) errors.lat = 'Need a number';
  if (typeof input.lng !== 'number' || !Number.isFinite(input.lng)) errors.lng = 'Need a number';
  return errors;
}

/** @param {QueueItem} i */
export const isPending = (i) => i.status === 'queued' || i.status === 'sending';
