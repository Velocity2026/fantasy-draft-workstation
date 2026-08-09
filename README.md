# Fantasy Draft Workstation

A private, single-user fantasy football draft and in-season decision tool, built
around one Sleeper league: **10 teams, full PPR, keeper.**

Not a product. No logins, no billing, no other users. It runs on your machine
and answers to you.

---

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer. Everything runs locally.

```bash
npm install
cp .env.example .env
```

Open `.env` and fill in two things:

- `SLEEPER_LEAGUE_ID` — from your Sleeper web address:
  `sleeper.com/leagues/`**`1234567890`**`/team`
- `SLEEPER_USERNAME` — your Sleeper username, so the app knows which team is yours

Then:

```bash
npm run setup
```

That creates the database, downloads every NFL player, imports your league,
walks back through prior seasons to learn how your league drafts, and builds a
first board. It takes a couple of minutes and is safe to re-run.

```bash
npm run dev
```

Open **http://localhost:3210**. The dashboard tells you what's ready and what
still needs doing.

---

## The pages

**Dashboard** — Is this ready to draft with? Every failing check links to the
page that fixes it.

**Draft Room** — The live one. It polls Sleeper every couple of seconds and
tells you who to take, why, and what happens if you wait. Also lets you enter
picks by hand when Sleeper lags or someone announces a pick verbally.

**Board** — Every player, valued for *your* league settings. Override any rank,
flag targets and do-not-drafts, leave yourself notes. Your overrides carry
through to the draft room.

**Keepers** — Whether each keeper is worth the pick he costs. Not "is he good" —
a great player at a first-round price is worth nothing in surplus terms.

**Mocks** — Runs your draft hundreds of times to answer the question that
actually matters: if you take a receiver now, will your running back still be
there next time around?

**Research** — Camp reports, beat notes, coach quotes. These build the evidence
trail the in-season features will read later.

**League** — How your specific managers draft. Who reaches, who waits on
quarterbacks, who you can predict.

**Sources** — Where the numbers come from, and how much each one counts.

**Settings** — League, your team, and the knobs on the valuation model.

---

## Adding and changing data sources

Swapping FantasyPros for somewhere else, or adding one writer whose opinion you
rate, is a row in a table — never a code change.

On the **Sources** page:

- **Add a source** — give it a short key, a name, and say what kind of data it
  provides. That's it.
- **Weight** controls how much its numbers move the projections. FTN at 1.2 and
  FantasyPros at 1.0 means a player projected 250 and 220 lands around 236.
- **Trust** (0–1) controls how much its *words* count. When you log a note from
  a source, its trust becomes that note's confidence, which is what the
  recommendation scoring reads.
- **Disable** a source to take it out of the blend while keeping its history, so
  you can still see what it used to say.

Most sites let you export what you're paying for as CSV. Drop the file in on the
Sources page and pick the source key. Column names are matched loosely, so most
exports work without editing. **Rows that can't be matched to a player are
reported back to you, never dropped silently** — a missing RB1 on draft day is
worse than a visible warning.

Rebuild the board afterwards for the new data to take effect.

### If a player has no projection

He falls back to an internal rank curve and is marked **est** on the board. That
exists so the board is never empty, not because it's good. Import real
projections before relying on those numbers.

---

## Command line

Everything on the pages is also a command, useful for scheduling:

```bash
npm run sync:all        # routine refresh — run the morning of the draft
npm run sync:players    # refresh the player list
npm run sync:league     # league, rosters, drafts
npm run sync:history    # walk prior seasons, rebuild manager profiles
npm run sync:market     # add/drop trends and ADP
npm run value           # rebuild the board and print the top 25
```

Import a CSV from the command line:

```bash
npx tsx scripts/import-csv.ts --file ~/Downloads/ftn.csv --source ftn --type projections
```

---

## How the numbers work

**Replacement level** is the bar every player is measured against — roughly, the
best player you could get for free. It's computed from your actual roster
settings, not a rule of thumb, and it accounts for the flex slot eating another
ten backs and receivers.

**VORP** is points above that bar. It's how you compare a quarterback to a tight
end.

**VONA** is what the draft room actually ranks by: not how good a player is, but
how much better he is than what you'd get at that position *at your next pick*.
That's the real decision, because you can't have everyone.

**Tiers** are placed at gaps in value, not at fixed intervals. Four players left
in a tier means you can wait. One means you can't.

**ADP** comes from your own league's draft history rather than a generic public
number — for ten specific managers, how they've actually behaved is a better
prediction than how the internet behaves.

---

## AI summaries

Optional. Add `ANTHROPIC_API_KEY` to `.env` and the Keepers, League and Draft
Room pages gain a "write it up" button that turns the numbers into prose.

The model is only ever given numbers the app already computed — it never
recalls stats from memory, and it's told to say so when the data is thin. It's
a writer, not the analyst. Summaries are cached, so re-reading a page costs
nothing.

Everything works without a key; those panels just say it isn't configured.

---

## Backing up

The whole database is one file: `prisma/dev.db`. Copy it before draft day.

```bash
cp prisma/dev.db "backups/dev-$(date +%F).db"
```

---

## What's not built yet

This is the draft-first release. The database and provider interfaces already
carry everything the in-season features need — weekly snaps, routes, target
share, red-zone work, depth-chart moves, injuries, transactions — so those
tables are ready before there's data to put in them.

Still to come: weekly data ingestion, waiver and breakout detection, start/sit
analysis, trade evaluation, and rest-of-season values. None of them require
redesigning what's here.

## Project layout

```
prisma/schema.prisma     the data model, heavily commented — start here
src/lib/providers/       Sleeper client, CSV adapters, provider interfaces
src/lib/sync/            imports and refreshes
src/lib/valuation/       replacement level, VORP, tiers, keeper surplus
src/lib/draft/           live draft state, advisor, Monte Carlo simulator
src/lib/sources.ts       the data-source registry
src/app/                 pages and server actions
scripts/                 command-line equivalents
```
