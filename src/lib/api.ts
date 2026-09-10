import { REQUEST_TIMEOUT_MS, NO_ANSWER } from './sync-core.mjs';
import type { HttpResult, QueueItem } from './sync-core.mjs';
import { wireBody } from './sync-core.mjs';

/**
 * All calls go to /api/... on our own origin, which the route handler in
 * src/app/api/[...path]/route.ts forwards to the mock server.
 *
 * Why the hop: the mock server sends no CORS headers and answers OPTIONS with
 * 404, so a browser at :3000 cannot talk to :4000 directly - and the brief says
 * do not modify that file. The proxy is a dev shim only; it makes no retry
 * decisions of its own. Everything that matters happens in sync-core.mjs.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';

async function request(
  path: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    });

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // A truncated or empty body is not itself an answer about whether the
      // report was stored. Leave it null and let the status code decide.
      body = null;
    }

    return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    // Offline, DNS failure, aborted timeout, or the socket died mid-request.
    // We did not hear an answer. That is not the same as "it failed".
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      status: NO_ANSWER,
      body: { reason: aborted ? 'timed out with no answer' : 'network unreachable' },
      retryAfter: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function postReport(item: QueueItem): Promise<HttpResult> {
  return request('/v1/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wireBody(item)),
  });
}

/** Reads the endpoint the assessment reads, so the app can show the same verdict. */
export function debugCount(): Promise<HttpResult> {
  return request('/v1/_debug/count', { method: 'GET' }, 10000);
}

export function debugReset(): Promise<HttpResult> {
  return request('/v1/_debug/reset', { method: 'POST' }, 10000);
}
