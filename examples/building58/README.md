# Setup note: Exhibit on Building58

This note is for the Building58 room. It adds Exhibit to Building58 in shadow mode, which is phase B of the field test ([docs/spec.md section 12](../../docs/spec.md#12-field-test)). In shadow mode, Exhibit gives its verdict on every PR, but nothing waits on it.

The field repos install published releases only, never Exhibit's source. So this note needs the release `v0.1.0`. It exists once the person pushes the tag `v0.1.0` to Exhibit. Check it at <https://github.com/bfalkowski/exhibit/releases/tag/v0.1.0> before you open the PR.

## What to add

Open one PR in Building58 that adds two files:

1. [exhibit.yml](exhibit.yml) as `.github/workflows/exhibit.yml`. It runs Exhibit on every PR in two jobs.
2. [evidence.yml](evidence.yml) as `evidence.yml` at the top of the repo. It is the first policy.

Change nothing else in the PR. A PR that changes `evidence.yml` always gets `needs_person`, so this first PR gets it too. That is expected. Exhibit reads the policy from the PR's base commit, which has no `evidence.yml` yet, so this PR's run uses no policy, and its summary says that no rule covers the change. The new policy checks the PRs that come after it merges (Exhibit's docs/spec.md section 8.1).

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

The test command runs `relay/test/*.test.js` the way `npm test` (`relay/test/run.js`) does: six files at a time, and each file with a new empty HOME of its own, so no test reads a room's files under `~/.office-world` or another file's. Exhibit reads the results from a JUnit file, and `run.js` writes none, so the command runs each file with `node --test` and its JUnit reporter, and then joins the files into `.exhibit/junit.xml`.

Each test has a time limit of 120 seconds, and each file one of 600 seconds, as in `run.js`. A file can leave a timer, a relay or a child process running after its last test, and then it never ends. Without the limit for each file, such a file would keep the check job running until its own time limit, and the job would make no exhibit. A short node script in the command, `RUN_FILE`, runs each file. When a file runs past 600 seconds, the script stops it and every process still under it, and writes a JUnit file with one failing test case, such as "relay/test/x.test.js ran past its time limit of 600 seconds". So the joined file names it, and the check says which file hangs. The other files go on. A process whose parent has ended is no longer under the file, so the script does not find it. It runs on until Exhibit stops the whole command, which Exhibit does when the command ends. macOS has no `timeout` command, so the script is in node, and `exhibit check` works the same on a Mac. To try a shorter limit, set `TEST_FILE_SECONDS`. The script reads it as `run.js` does, so a value that is not a number, or 0, gives 600.

A file that hangs can still make the check job pass its 60-minute limit. Then the job makes no exhibit, and it does not say which file hangs. Each run waits the full 600 seconds for that file. While it waits, the other files share the five other places, and the file can start near the end of the run. So on a GitHub runner, where a run takes about 8.5 minutes, a run with the file takes from about 10.5 minutes up to about 18.5 minutes. The file counts as failed, so Exhibit runs that side a second time. A real run on a Mac shows it: the test command on Building58's `main` (1d48956), with one added file that leaves a timer running, took 938 seconds, against 7.5 minutes without the file. The added file is last by name, so it started late.

Two cases pass the limit:

- The file hangs on the base and on the head. The four runs take 42 to 74 minutes, and the six runs of a fix take 63 to 111 minutes. This needs the file to hang on the PR's base too, which is rare.
- A fix PR adds or changes a test file, and that file hangs. For a fix, Exhibit also runs the base with the PR's test files, and a test that leaves a timer running usually hangs there too. The base passes in one run, and the head and the base with the PR's test files take two runs each: 50.5 to 82.5 minutes. This is the case the limit for each file is for, so it is not rare.

A lower limit for each file does not fix this. The slowest file in that run took 125 seconds, and six runs fit in 60 minutes only with a limit of about 1 minute. So the limit stays at 600 seconds. When the check job stops at its time limit, run `npm test` on the PR's branch, and on its base if that hangs too. `run.js` names a file that does not end. Fix that file in the PR, or on the base first when the base has it.

The command differs from `npm test` in two ways:

- It does not take the room's settings (`OFFICE_*`, `RELAY_*`, `CLAUDE_CODE_*`) out of the environment. On CI there are none. A session that runs `exhibit check` on its own computer runs it from a room, so it may see different results.
- It leaves out the browser tests in `relay/test/browser/`.

A real run of this test command on Building58's `main` (145143a) passed: 1338 test cases, none failed, 3 skipped, in 7.5 minutes on a Mac. The same files, one at a time with one shared HOME, took 39 minutes there, and more than 72 minutes for two runs on a GitHub runner, so this policy does not do that. A room ticket can make it simpler later: if `run.js` writes JUnit, the command can be `node relay/test/run.js` again.

The `load` probe starts with `set -e`, so a step that fails, such as `git merge-base` with no `origin/main`, or `npm ci`, fails the probe. It never passes without running the tests. The probe is not the same each time: on one commit it passed in one run and failed in the next, when two test files timed out under the load. That is what it looks for, but it can also ask for a fix on a PR that only touched a test file that was flaky before.

Two settings wait for a newer release. `v0.1.0` refuses both, so the policy leaves them out:

- `test_timeout_seconds: 900`. A full test run takes about 8 minutes. In a phase A check run, `relay/test/lead-check.test.js` hung for 40 minutes on an older commit. Without a limit, a hang holds the check job until its own limit of 60 minutes.
- `source_paths: ["relay/**", "office/**", "shared/**"]`, with `failing-before: { when: [fix, feature] }` in `needs-you`. Building58 PRs have no labels, so `v0.1.0` never sees a feature. So `needs-you` asks every PR for a failing test, a refactor too. With `source_paths`, a PR that adds a file there is a feature, as PR 48 was, and a PR that only changes the files there needs a failing test only when it is a fix.

Once the setup note pins a release that has Exhibit tickets 162 and 178, add both in a PR of their own.

The `load` probe finds the changed test files with `git merge-base HEAD origin/main`, so `origin/main` must be in the clone. The workflow's `fetch-depth: 0` gives it. It runs three copies of `relay/test/run.js` at once with `TEST_SLOTS=0`, so the copies do not wait on each other's slots, and the machine is busy. So the policy sets `probe_timeout_seconds` to 1200. The `room-settings` probe runs `node --test` and not `run.js`, because `run.js` takes the room's settings away.

The new rules are in shadow mode like the rest. The backtest (Exhibit's slice S8) and the first weeks of phase B show how often each one asks for evidence that a PR did not need.

## After it merges

- Each PR gets an "Exhibit check" job and an "Exhibit publish" job, and one comment from Exhibit that says "Shadow mode: nothing waits on this."
- Neither job is a required check. Do not add them to branch protection.
- Only the person sets `enforce: true`. Building58 stays in shadow mode in phase C.
- When Exhibit does something wrong, file an issue in the Exhibit repo and attach the `evidence.json` from the run's `exhibit` artifact (spec 12, "Friction").
