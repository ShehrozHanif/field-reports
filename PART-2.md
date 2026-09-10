# Part 2 — taking the system off one laptop

The laptop is not really the problem. The problem is that one person's memory is
load-bearing, and memory does not answer the phone. So the goal for the week is
not to modernise anything — it is to turn one person's knowledge into two
people's access. I would order the work by what breaks first, not by what is
most satisfying to fix.

**First: find what exists only on that laptop.** A `.env` nobody else has, a
script, a migration that was run by hand and never committed. Access can be
recovered with enough effort; lost data cannot.

**Then the secrets.** Into the vault the company already uses, readable by a
second person, and rotated afterwards.

**Then deploy access — and prove it.** A second person on Vercel and on the
database provider ships a one-word change and rolls it back. Access nobody has
used is a permissions row, not access.

**Then the things that fail silently.** The cron jobs: find them, and move them
to the platform's scheduler or write down how to run them by hand. The backups:
confirm they exist and that someone else can actually restore one. And who owns
the domain, the DNS and the billing — a card on one person's account can take
the site down on its own.

**Then one page, in the repo:** how to deploy, how to roll back, what runs on a
schedule, and who to call when the site is down.

**Deliberately left until later:** infrastructure as code, a CI pipeline, any
move off Vercel or Postgres, any refactor. All defensible, and none of them help
a team whose only deployer is unreachable on Wednesday. Rewriting access is also
risky at the exact moment you need it widened.

The check on day eight is not whether a document exists. It is whether the
second person has actually deployed something.
