/**
 * Dev-only pass-through to the mock server.
 *
 * The mock server sends no CORS headers and answers OPTIONS with 404, so the
 * browser cannot call it cross-origin from :3000 - and the brief says not to
 * modify that file. So the page calls /api/... on its own origin and this
 * handler forwards it verbatim.
 *
 * It deliberately does NOT retry, cache, or interpret anything. The one thing
 * it translates is an upstream connection that dies with no response: Node's
 * fetch throws there, and the browser needs a status, so it gets 599 - which
 * sync-core.mjs treats exactly like a status-0 network failure, i.e. "we do not
 * know whether it was stored, retry with the same id".
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TARGET = process.env.MOCK_API_URL || 'http://localhost:4000';

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const search = new URL(req.url).search;
  const target = `${TARGET}/${path.join('/')}${search}`;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { 'content-type': req.headers.get('content-type') || 'application/json' },
      body: hasBody ? await req.text() : undefined,
      cache: 'no-store',
    });

    const text = await upstream.text();
    const headers = new Headers({ 'content-type': 'application/json' });
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) headers.set('retry-after', retryAfter);

    return new Response(text, { status: upstream.status, headers });
  } catch (err) {
    return Response.json(
      {
        error: 'upstream_connection_lost',
        reason: 'connection dropped before the server answered',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 599 }
    );
  }
}

export const GET = proxy;
export const POST = proxy;
