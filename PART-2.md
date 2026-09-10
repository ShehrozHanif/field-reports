# Part 2 — taking the system off one laptop

The laptop is not really the problem. The problem is that one person's memory is
load-bearing, and memory does not answer the phone. So the goal for the week is
not to modernise anything — it is to turn one person's knowledge into two
people's access.

I would rank the work by what breaks first if they disappear today, not by what
is most satisfying to fix.

**First, before anything else: find out whether the laptop holds the only copy of
something.** Not access — data. A `.env` nobody else has, a seed script, a
migration that was run by hand and never committed. Everything else on this list
is recoverable with enough shouting; that is not. Ten minutes of asking "what is
on there that is nowhere else" is the highest-value time in the week.

**Then the secrets.** Nothing else is possible until a second person can read the
production environment variables and the database credentials. Into whatever
shared vault the company already uses — not a new one chosen this week — and
rotated afterwards, because they have now been in more places than they were.

**Then deploy access, and prove it.** A second person on the Vercel project and on
the Postgres provider, then have them ship a one-word copy change end to end, and
roll it back. Access that has never been used is not access; it is a permissions
row. The first time anyone discovers the account is on a personal email is during
an outage, and it should not be.

**Then the cron jobs**, which are the part I would actually worry about. Scheduled
work running on a laptop has usually already failed quietly at some point and
nobody noticed, because a job that does not run does not page anyone. I would find
out what they are, what they touch, and move them onto the platform's scheduler.
If a job is too tangled to move in a day, write down what it does and when, so a
human can run it by hand — a manual runbook step beats an invisible one.

**Then one page of writing**: how to deploy, how to roll back, what runs on a
schedule, what to do when the site is down, and which vendor to call. One page,
in the repo, not a wiki nobody can find.

**Deliberately left until later:** infrastructure as code, a CI pipeline with
tests, any migration off Vercel or Postgres, and any refactor of the app itself.
All defensible, none of them help a team whose only deployer is unreachable on
Wednesday. Terraforming the account is a rewrite of access at the exact moment you
need access widened.

The check on day eight is not whether the document exists. It is whether the
second person has actually deployed something. If they have not, nothing changed —
we just wrote a document about a laptop.
