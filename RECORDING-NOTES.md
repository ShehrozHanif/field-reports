# 3-minute recording — running order

Not a script to read. These are the beats, with the things worth saying out loud.
They said quality does not matter and that they would rather hear you name the
weak part than watch a polished tour, so: talk over it, and do not re-record for
a stumble.

**Before you hit record**

- Three terminals up: `node mock-server.js`, `npm run dev`, one free.
- Browser at localhost:3000, devtools open on the Network tab.
- Clear the queue (Clear finished) and hit `POST /v1/_debug/reset` once so the
  numbers start at zero.

---

### 0:00 — what the problem is (20s)

Six in ten requests fail, and two in ten *save the report and then kill the
connection*. So the client sees a network error for a report the server already
has. Retry naively and you have a duplicate. Say that first — it frames
everything else.

### 0:20 — the one line that solves it (40s)

Open `src/lib/outbox.ts`, point at `mintId()` inside `enqueue`.

> The id is generated once, here, when the worker hits Submit, and it is stored
> on the device with the report. Every retry after that carries the same id. It
> is never regenerated — not on retry, not on relaunch, not after a crash.

Then `classify()` in `sync-core.mjs`, and point at the `409` branch:

> This is the part people get wrong. A 409 is not an error. It is the server
> saying "I already have this" and handing back the original id. So I mark it
> sent.

And the status-0 branch:

> And this one. Connection dropped, timed out, offline — we do not know whether it
> was stored. So we do not guess in either direction. We ask again with the same
> id and let the server be the one that knows.

### 1:00 — why it survives a hard close (40s)

`drain()` in `outbox.ts`. Point at the order:

> Mark it sending, write that to disk, *then* send. If the app dies in the middle,
> the item is sitting on disk marked sending on the next launch, and
> `recoverInterrupted` puts it back in the queue under its original id.

Then show it. Submit two or three reports, and while one is in flight **close the
whole browser**, not the tab. Reopen. Point at the queue coming back, and at the
row that ends up saying *"server already had this one, so it was not stored
twice."*

### 1:40 — offline for real (30s)

Devtools → Offline. File a report. Show the queue saying, in words, *saved on this
device, not yet with the server*, with the countdown and the attempt count.

> It never says sent. Nothing says confirmed until the server has given us an id.

Go back online. Watch it drain.

### 2:10 — the verdict (20s)

Hit the **Server check** button in the app, or run `npm run verify` in the free
terminal. Point at `duplicates_created: 0` and at the 409 count.

> Two 409s. That is two duplicates that did not happen.

### 2:30 — the weak part (30s)

Pick one from the README and mean it. The strongest one to say out loud:

> The thing I am least sure about is that it retries forever. There is no give-up.
> On a low-end phone on mobile data that is somebody's battery. I did not put a
> ceiling in because I do not know what the right number is without knowing how
> these teams actually work — I would rather ask than invent one.

If there is room, add the second one: the server dedupes on content, so two
genuinely separate submissions with identical text and the same millisecond
timestamp would read as a duplicate. You guard the realistic cause at the UI, but
that is a guard, not a guarantee.

Then stop. Do not summarise.

---

**One thing not to do:** do not narrate every file. Three minutes buys you the id,
the 409, the crash recovery, and the honest bit. Everything else is in the README.
