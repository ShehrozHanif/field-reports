# Field Reports

One screen. A field worker files a report; it reaches the server exactly once,
whatever the network does in between.

Next.js (App Router) + TypeScript. No state library, no HTTP client, no offline
framework — the queue is about 300 lines and all of it is in this repo.

---

## Running it

You need three terminals and Node 18+.

```bash
# 1. the mock server (see the note below about the file)
node mock-server.js

# 2. the app
npm install
npm run dev            # http://localhost:3000

# 3. the proof, any time
npm run verify
```

**About `mock-server.js`:** it is deliberately **not committed**. It hashes its own
source to prove it was not edited, and a copy that picked up a stray line ending
on its way through git or a zip would fail that check for no reason at all. Drop
your original file into the project root and it will run. `.gitignore` has a note
saying the same thing.

The app talks to the mock server through `/api/...` on its own origin. The mock
server sends no CORS headers and answers `OPTIONS` with a 404, so a browser at
:3000 cannot call :4000 directly — and the brief says not to modify that file. So
`src/app/api/[...path]/route.ts` forwards requests verbatim. It is a development
shim with no logic of its own; see *Things I added that would not exist in
production* below.

**GPS is hardcoded when the device will not give a fix.** The form asks the
browser for a location. If that fails — permission denied, no GPS on a desktop,
or no answer within 8 seconds — it falls back to **Karachi city centre,
`24.8607, 67.0011`**, and says so on screen. Both fields stay editable. The
brief says geolocation is not what is being tested, so a missing fix never
blocks a report.

---

## The one rule

> The same report must never be stored twice on the server, no matter what the
> network does.

Six in ten requests fail. Two in ten **store the report and then kill the
connection before answering**. So a client that sees "network error" and retries
naively creates a duplicate, and it cannot tell that case apart from a request
that never arrived.

The contract has the way out. `client_report_id` is optional, and if you send it
the server will not store a second report under the same value — it returns `409`
with the original `report_id`.

So the whole design is one sentence:

**A report is given one `client_report_id` at the moment the worker hits Submit,
that id is stored on the device with the report, and every retry for the rest of
that report's life carries the same id.**

The id is minted in exactly one place (`mintId()` in `src/lib/outbox.ts`) and is
never regenerated, not on retry, not on relaunch, not after a crash. `409` is then
not an error — it is the server telling us a duplicate was correctly prevented, and
handing back the id we should have had. We record it as sent.

`npm run verify` reports `409s the server had to send`. Each one is a duplicate
that did not happen.

---

## What happens on each answer

`src/lib/sync-core.mjs`, `classify()`:

| What came back | What we do | Why |
|---|---|---|
| `201` | done | the server has it |
| `409` | **done** | the server already had it — a retry that correctly did not duplicate |
| `400` / `413` | give up, tell the worker | retrying a malformed report can only fail again |
| `429` | wait `Retry-After`, then retry | the server told us how long |
| `500` `502` `503` | retry with backoff | transient |
| connection dropped, timeout, offline | **retry with the same id** | we do not know whether it was stored — so we ask again rather than guess |

That last row is the whole task. We never treat silence as failure, and we never
treat it as success. We re-ask, and let the server be the one that knows.

Backoff is exponential with jitter, 1s doubling to a 30s ceiling. The jitter is
not decoration: without it, a queue that filled up while offline fires every item
on the same tick the instant the network returns.

When the browser fires `online`, items waiting out a backoff are made due
immediately (`wakeForReconnect()`), because after a few offline failures that
wait is up to 30 seconds of a queue that should be moving. A `429` wait is left
alone, since the server asked for it. `online` is only a hint: if it is wrong,
the send fails and the item goes straight back into backoff.

---

## Surviving a hard close

The queue lives in **IndexedDB**, not in React state — that is what makes it
survive the tab being closed, the browser being quit, or the phone force-quitting
the app.

Sending one item is three steps, in this order:

1. mark it `sending` **and write that to disk**
2. POST it
3. write the outcome to disk

If the app dies between 1 and 3 — and it will, that is what a force-quit is — the
item is found in `sending` on next launch. `recoverInterrupted()` puts it back in
the queue under its original id. It gets resent, the server says `409`, and it is
confirmed. No duplicate.

`npm run verify` does exactly this: it kills the process mid-flight on purpose and
then relaunches.

Two other things in that area:

- **Two tabs.** The drain takes a Web Lock (`navigator.locks`), so only one tab
  drains at a time. If both did, the server would still dedupe them, but the second
  request is wasted work on a connection that is already bad.
- **Opening the app offline.** `public/sw.js` is a small network-first service
  worker whose only job is letting the app be *cold-launched* with no signal.
  Without it the queue survives fine, but a worker standing in an outlet with no
  bars cannot open the page to see it. `/api/` is never cached — a cached `201`
  would be the exact lie this app exists to avoid.

---

## What the worker is told

They are graded on this and they should be: *"whether the user is ever told
something was sent when it wasn't."*

Nothing says **Confirmed** until the server has handed back a `report_id`, from a
`201` or a `409`. Until then it says, in words, *"saved on this device, not yet
with the server"*, with the attempt count, the reason for the last failure, and a
live countdown to the next try.

If the device itself refuses to store the report — storage full, IndexedDB
disabled — the form does not clear and says plainly that nothing was saved and
nothing was queued, because at that moment the text on screen is the only copy
that exists.

---

## Layout

```
src/lib/sync-core.mjs      every decision, as pure functions. no network, no DOM,
                           no React. the browser and the test harness run this
                           same file.
src/lib/db.ts              IndexedDB. ~60 lines, no wrapper library.
src/lib/api.ts             one fetch, with a timeout, that never throws.
src/lib/outbox.ts          the loop: lock, mark, send, record, recover.
src/components/            form, queue list, a button that reads _debug/count.
src/app/api/[...path]/     dev-only proxy (CORS).
public/sw.js               cold-launch-offline shell cache.
test/harness.mjs           the same queue, with a JSON file instead of IndexedDB.
test/verify.mjs            seed → crash → relaunch → check.
```

The split between `sync-core.mjs` and everything else is deliberate: the file that
decides whether a report is done contains nothing that needs a browser, so the
headless harness runs *the code that ships* rather than a re-implementation of it.

---

## Proving it

```
$ npm run verify

=== 1/4  reset server, queue six reports
=== 2/4  drain, then force-quit mid-send
  Al-Madina Store       attempt 1 [201] accepted (srv_4fee84c1b277)
  Bismillah Kiryana     attempt 1 -> firing, then killing the process
  *** process killed while the request was in flight ***
=== 3/4  relaunch and finish the queue
  recovered Bismillah Kiryana - was interrupted mid-send, requeuing
  Bismillah Kiryana     attempt 2 [409] accepted via 409 - server already had it, NOT stored twice
  ...
=== 4/4  what the assessment reads
  duplicates_created ......... 0
  reports stored on server ... 6
  confirmed on this device ... 6
  409s the server had to send  2  (each one is a duplicate that did not happen)
  save-then-drop hits ........ 2
  PASS - no duplicates
```

Also run by hand in a real browser: four reports submitted, the whole browser
killed mid-sync, relaunched — queue recovered, two `409`s, `duplicates_created: 0`.
And with devtools offline: reports filed with no network, browser hard-closed
while still offline, relaunched still offline (the service worker serves the
shell), queue intact, then the network restored and everything drained clean.

---

## Not built, on purpose

No photo, no login, no history list, no design work — the brief says so, and time
spent there is time not spent on the queue.

---

## What I am least confident about

Honest list, roughly in order of how much it would bother me in production.

**1. It retries forever.** There is no give-up. A report that can never be
delivered — a permanently changed endpoint, an outlet record the server has since
rejected — retries every 30 seconds for as long as the app is open. On a low-end
phone on mobile data that is somebody's battery and somebody's data bundle. The
right answer is probably a ceiling after which the report is flagged for the
supervisor rather than silently dropped, but I do not know what that ceiling
should be without knowing how these teams actually work, so I left it retrying
rather than invent a number.

**2. The server dedupes on content, and I only defend that at the UI layer.**
`client_report_id` protects a report across *its own* retries. But the server's
duplicate check hashes the content — outlet, finding, action, `captured_at`, lat,
lng — so two *different* submissions with identical text and the same millisecond
timestamp would count as a duplicate even though the client did nothing wrong. I
guard against the realistic cause (a double tap on a slow phone) with an in-flight
ref and by clearing the form, and I have not been able to make it fire. But that is
a UI guard, not a guarantee, and I have not proven it holds under a slow render on
a genuinely slow device. If I could ask one question about the contract, it would
be this one.

**3. The multi-tab lock has no real fallback.** `navigator.locks` is well
supported and it is what I use, but where it is missing the code just runs
unlocked. Two tabs would then both drain. The server still dedupes, so it is
*correct* — it is only wasteful. Still, "correct by luck, downstream" is not the
same as correct, and a localStorage lease with an expiry would close it.

**4. I have not run this on a real low-end Android phone.** Desktop Chromium and
a headless harness only. Old Android WebViews are exactly where IndexedDB and
service workers get strange, and that is the device the brief describes. I would
not claim this works there until I had held one.

**5. No storage-quota strategy.** The form now fails honestly if IndexedDB
refuses a write, which is better than silence, but there is no eviction, no size
cap and no warning as the queue grows. A worker offline for a week is a case I
have handled correctly and not *sized*.

**6. Recovery counts an interrupted send as an attempt.** I made
`recoverInterrupted` increment the attempt counter, so an app that crashes on
every launch backs off instead of hammering. The cost is that a worker who
force-quits the app for unrelated reasons pushes their own report further down the
backoff curve. I think that trade is right, but it is a judgement call I made
alone and I would want it challenged.

## Things I added that would not exist in production

The `/api` proxy. It exists only because the mock server has no CORS headers and
the brief says not to touch it. It forwards requests unchanged and makes no retry
decisions — the one thing it translates is an upstream connection that dies with
no response, which Node's `fetch` throws on and a browser needs a status for; it
becomes `599`, which `sync-core` treats identically to a browser-level network
failure. It is worth naming because it sits in the path of every request during
the demo: if that proxy ever turned a dropped connection into a `2xx`, the entire
guarantee would evaporate. It does not. But in production the app would talk to
the API directly and this file would be deleted.
