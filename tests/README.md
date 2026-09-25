# Tests

Automated checks for Pet Health Tracker. They run the real `index.html` in simulated browsers connected to a fake Firebase that behaves like the real one: live updates between devices, offline mode, and your `firestore.rules`. Nothing touches your real Firebase or your users' data.

Run them before every push. A full run takes about a minute and a half.

## First-time setup

You need Node.js (the same install you use for backups).

In PowerShell, in this `tests` folder:

```
npm install
```

That downloads the one library the tests use into `node_modules`. The repo's `.gitignore` keeps that folder out of git.

## Running the tests

```
npm test
```

You'll see one line per group, desktop and mobile layouts:

```
PASS Sync  24/24
PASS Routine  18/18
...
All 215 checks passed.
```

If anything fails, it lists which check and what it found instead. Don't push until it passes, or until you've confirmed the failure is expected (see below).

### Options

| Command | What it does |
|---|---|
| `npm test -- --verbose` | Lists every check, not just failures |
| `npm test -- --quick` | Desktop layout only, about twice as fast. Handy while you're working; run the full `npm test` before pushing |
| `npm test -- --previous old.html` | Also runs an older copy of the app alongside the new one, to check they can share a vault safely. Save the live `index.html` as `old.html` before pushing your change |
| `node run-tests.js path\to\index.html` | Tests a different copy of the app |

## What's tested

| Group | Checks |
|---|---|
| Setup | `version.json`, `DATA_VERSION` and the rules' `minVersion` agree; no undefined theme colors |
| Conversion | Logs in the older format convert without losing anything |
| Sync | Devices sharing a vault: stale devices, offline logging, loading codes, new vaults, edits during updates |
| Everyday | Evening dates, stored text shown safely, editing logs |
| Routine | Suggestions, stars, Log all, weigh-ins, Undo, form logs ticking the checklist |
| Doses | Default doses, per-log edits, typing while another device syncs, "stop daily" |
| Charts | Daily weights, 7-day average, summary, vomit per week |
| Update protection | Save stamps, refused outdated copies, reload banner, newer data formats |
| Themes | Picking, saving and loading themes; chart colors follow the theme; every theme color is defined |

## When a test fails

- **You changed something on purpose** (e.g. renamed a button or changed how a feature works): the test that checks the old behavior needs updating. Each check has a plain-English name, so search `run-tests.js` for it.
- **You didn't mean to change that behavior**: it's a bug. Fix the app, not the test.
- **You changed the logic of `firestore.rules`** (not just a field list or number): update `makeRules()` in `run-tests.js` to match. Field lists, limits and `minVersion` are read from the rules file automatically.

## Sample data

`sample-data.json` holds two made-up vaults in the older log format, so every run also tests conversion. **Never put real users' data in this folder**: the repo is public.

"Today" in the tests is always 2026-09-24 at 10:00 AM US Eastern, so results don't depend on when or where you run them.
