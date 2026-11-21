# Setup note: Exhibit on Building58

This note is for the Building58 room. It adds Exhibit to Building58 in shadow mode, which is phase B of the field test ([docs/spec.md section 12](../../docs/spec.md#12-field-test)). In shadow mode, Exhibit gives its verdict on every PR, but nothing waits on it.

The field repos install published releases only, never Exhibit's source. So this note needs the release `v0.1.0`. It exists once the person pushes the tag `v0.1.0` to Exhibit. Check it at <https://github.com/bfalkowski/exhibit/releases/tag/v0.1.0> before you open the PR.

## What to add

Open one PR in Building58 that adds two files:

1. [exhibit.yml](exhibit.yml) as `.github/workflows/exhibit.yml`. It runs Exhibit on every PR in two jobs.
2. [evidence.yml](evidence.yml) as `evidence.yml` at the top of the repo. It is the first policy.

Change nothing else in the PR. A PR that changes `evidence.yml` always gets `needs_person`, so this first PR gets it too. That is expected.

## The workflow

The workflow is [examples/pull-request.yml](../pull-request.yml) with three changes:

- The check job sets up Node with `lts/*`, as Building58's CI does. Exhibit needs Node 20 or later, so the check job does not use Node 18.
- The check job has a time limit of 60 minutes, and the publish job one of 10. A check runs the tests on the base and on the head, and once more on the base for a fix. On a GitHub runner (`ubuntu-24.04`), a full check of Building58 PR 147 took 17 minutes (two test runs), and of PR 111, a fix, 24 minutes (three test runs). If the check job is always much faster than its limit, lower the limit. If it often comes near the limit, make the tests faster.
- Both jobs pin `bfalkowski/exhibit@v0.1.0`. Keep the same release in both jobs. Do not pin `v0` or `main`. They move, so the check job and the publish job of one run could get different code. To move to a newer release, change both lines in a PR of its own.

The runner is `ubuntu-24.04`, where Exhibit's own real runs passed. Building58's CI uses `ubuntu-24.04-arm` because it costs less. Exhibit is plain JavaScript, so arm should work, but no real run has shown it yet.

## Token permissions

The workflow sets every permission itself, so the repo's default token setting ("Read repository contents") does not matter.

| Job | Permission | Why |
|---|---|---|
| check | `contents: read` | Read the code and the PR. Building58 is public, so this reads the PR too. The check runs the PR's code, so it gets nothing more. |
| publish | `contents: write` | Push the exhibit to the `exhibit-data` branch. The first run makes the branch. |
| publish | `pull-requests: write` | Post the summary comment on the PR, or update it. |

The publish job never checks out or runs the PR's code. It is skipped for a PR from a fork. No secret is needed: both jobs use the job's own token.

Building58's branch protection covers `main` only, so the publish job can push `exhibit-data`. If a ruleset later covers all branches, let the Actions bot push `exhibit-data`, or set `settings.storage: local` in `evidence.yml`.

## The first policy

[evidence.yml](evidence.yml) has five kinds of change. A PR can match more than one, and then it needs what each of them needs.

| Kind | Files | Risk | Needs |
|---|---|---|---|
| `code` | `relay/`, `office/`, `shared/`, `index.html`, the packages, the git hooks, CI and the lint config | medium | The tests on the base and the head. For a fix, a test that fails before the change. |
| `docs` | `docs/` and every Markdown file | low | The manual's checks, the same ones CI runs for a docs-only change. |
| `relay-tests` | `relay/test/*.test.js` | medium | The `load` probe: each test file the PR added or changed runs three times at once. |
| `test-helpers` | `relay/test/helpers.js` | medium | The `room-settings` probe: the tests that start relays run with a room's settings set. |
| `needs-you` | `relay/needs-you-plan.js`, `relay/needs-you.js`, `office/needs-you.js` | medium | The tests on the base and the head, and a test that fails before the change, for every PR. |

The last three come from Building58's own escaped defects. The person labeled them in phase A of the field test, and [docs/field/phase-a-labels.md](../../docs/field/phase-a-labels.md) gives each rule with the defects behind it. Each rule names those defects in `source`.

Any other file needs the tests. A PR is a fix when it has the label `bug`, its title starts with "fix" after the ticket key (such as "T-401: Fix the store"), or its branch starts with `fix/`.

The test command runs `relay/test/*.test.js` the way `npm test` (`relay/test/run.js`) does: six files at a time, and each file with a new empty HOME of its own, so no test reads a room's files under `~/.office-world` or another file's. Exhibit reads the results from a JUnit file, and `run.js` writes none, so the command runs each file with `node --test` and its JUnit reporter, and then joins the files into `.exhibit/junit.xml`. It differs from `npm test` in three ways:

- It has no time limit for each file, only for each test (120 seconds). A file that never ends stops the check job at its time limit.
- It does not take the room's settings (`OFFICE_*`, `RELAY_*`, `CLAUDE_CODE_*`) out of the environment. On CI there are none. A session that runs `exhibit check` on its own computer runs it from a room, so it may see different results.
- It leaves out the browser tests in `relay/test/browser/`.

A real run of this test command on Building58's `main` (145143a) passed: 1338 test cases, none failed, 3 skipped, in 7.5 minutes on a Mac. The same files, one at a time with one shared HOME, took 39 minutes there, and more than 72 minutes for two runs on a GitHub runner, so this policy does not do that. A room ticket can make it simpler later: if `run.js` writes JUnit, the command can be `node relay/test/run.js` again.

The `load` probe finds the changed test files with `git merge-base HEAD origin/main`, so `origin/main` must be in the clone. The workflow's `fetch-depth: 0` gives it. It runs three copies of `relay/test/run.js` at once with `TEST_SLOTS=0`, so the copies do not wait on each other's slots, and the machine is busy. So the policy sets `probe_timeout_seconds` to 1200. The `room-settings` probe runs `node --test` and not `run.js`, because `run.js` takes the room's settings away.

The new rules are in shadow mode like the rest. The backtest (Exhibit's slice S8) and the first weeks of phase B show how often each one asks for evidence that a PR did not need.

## After it merges

- Each PR gets an "Exhibit check" job and an "Exhibit publish" job, and one comment from Exhibit that says "Shadow mode: nothing waits on this."
- Neither job is a required check. Do not add them to branch protection.
- Only the person sets `enforce: true`. Building58 stays in shadow mode in phase C.
- When Exhibit does something wrong, file an issue in the Exhibit repo and attach the `evidence.json` from the run's `exhibit` artifact (spec 12, "Friction").
