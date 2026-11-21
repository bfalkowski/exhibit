# Field test Phase A: the labels and a first policy

Ticket 257. Spec section 12, Phase A, second half.

The backtest (S8) needs a policy to test, and `exhibit policy suggest` is not built. So the person labeled Building58's escaped defects with `exhibit label --claude`, and a first policy was written by hand from the labels. It replaces the starter policy in the [Building58 setup note](../../examples/building58/README.md). The Building58 room opens the PR in its own repo.

## How the labels were made

- The history run of ticket 256 ([phase-a-history.md](phase-a-history.md)) read fix PRs only up to PR 132. So first the person added 12 later fix PRs to the run-only `evidence.yml` in the clone `~/code/repo/exhibit-phase-a/building58`. They picked them from the titles:
  - Flaky tests: 133, 136, 137, 138, 139, 142, 144.
  - Product bugs: 135, 140, 143, 145, 148.
  - Left out as changes, not fixes: 134, 141, 146, 147.
- `exhibit history --repo bfalkowski/Building58 --full` ran again on 2026-11-20, from Exhibit at `main` 466299b. It read the same 146 merged PRs and found 46 fix PRs, and SZZ linked 27 of them. So there are 27 escaped defects, up from 20. It made 56 REST requests (38 got a 304) and 3 GraphQL queries. REST left went from 4,818 to 4,789.
- Then `exhibit label --claude` ran with the person, with the default model `claude-opus-5-5`. For each defect, the person kept or rejected each SZZ link, then confirmed, edited or threw away Claude's draft, and gave the evidence that would have caught the bug. Claude drafted only the code and the category.
- That run labeled 26 defects, and the person skipped D-071 ("1 tasks are being built"). A review of PR 50 found that bug and filed it as a follow-up, so review saw it.
- Then this branch merged `main`, which had added `known_at_review` to each labels line (ticket 157). The new `exhibit label` refuses a file whose lines lack it, and the spec says to set it by hand on older lines. So, with the person's agreement, the 26 lines got `null` (nobody knows), except D-066, which got `true`: its fix PR says "Follow-up to PR 47 (T-232), review finding 1", and the person kept the link to PR 47. A second `exhibit label --claude` run, from the merged Exhibit, then labeled D-071: the person kept the link to PR 50, confirmed the draft, and answered yes to "did review see this bug". Exhibit proposed yes too, from the fix PR's body.
- So D-066 and D-071 are deferrals: review saw each one, and a person chose to fix it later. A deferral is never a policy miss (spec 8.4 and 9.9), so neither is behind a rule.
- The labels file is copied here as [building58-labels.jsonl](building58-labels.jsonl), so the backtest can read it.

## Results

| | Count |
|---|---|
| Fix PRs that SZZ linked | 27 |
| Labeled | 27 |
| Deferrals (`known_at_review: true`) | 2: D-066, D-071 |
| Escaped defects, not counting deferrals | 25 |
| Labeled defects with at least one link the person kept | 19 |
| Labeled defects with every link rejected (a real bug with no known introducing PR) | 8 |
| SZZ links kept | 27 of 71 |

Most rejected links blamed an export list, an import, a list of kinds, a manual paragraph, or a PR that only removed comments. The bug's own lines often came from commit `9a7e34b`, which is in no PR (phase-a-history.md).

### How often the person kept Claude's draft

`exhibit label --claude` printed this at the end of the second run:

> Claude's drafts in the whole labels file: 27 shown. 26 kept unchanged, 1 edited, 0 replaced. The person kept 96% of the drafts unchanged (26 of 27, 95% interval 81% to 100%).

The person confirmed many drafts in a row. A long run of near-identical questions can make a person accept more than they would one at a time, so read the 96% with that in mind.

The one edit was D-144: the person changed the category from "Race condition" to "flaky test", the name their fix list uses. Claude then used "flaky test" for the later flaky tests by itself.

### Counts by category

Deferrals are in their own column. They are labeled, but they are not escaped defects, and no rule uses them.

| Category | Escaped defects | With a kept link | Deferrals |
|---|---|---|---|
| Missing feature path | 8: D-140, D-126, D-122, D-119, D-118, D-070, D-059, D-047 | 2: D-126, D-070 | |
| flaky test | 6: D-144, D-139, D-136, D-131, D-088, D-052 | 6 | D-066 |
| Stale state | 4: D-120, D-099, D-060, D-053 | 4 | |
| Race condition | 2: D-145, D-056 | 1: D-145 | |
| Test environment leak | 2: D-135, D-092 | 2 | |
| Missing retry backoff | 1: D-148 | 0 | |
| Inconsistent rules across views | 1: D-061 | 1 | |
| Incomplete integration | 1: D-030 | 1 | |
| Wrong pluralization in message | 0 | | D-071 |

## The first policy

The rule for keeping a rule comes from ticket 199 and spec section 9.9: a rule needs at least two labeled defects of one category, each with a link the person kept and none a deferral. The diff must show when it applies. So the `match` of a rule is only the files that the introducing PRs of at least two of those defects changed, where the blamed lines are.

### Rules kept

**`relay-tests`: the `load` probe.** Category "flaky test". Source: D-144, D-139, D-136, D-131, D-088.
- Each was a test that raced a timer or a kept-alive connection. It passed alone and failed on a busy machine. Each introducing PR (109, 129, 88, and the 7 of D-088) changed a file in `relay/test/*.test.js`.
- Match: `relay/test/*.test.js`. This is the one exception to the rule above, chosen by the person. The introducing PRs changed about 35 of the folder's 137 test files, but a flaky test can come in any new test file, and a list of the old files would never probe it.
- Needs: a probe that runs each test file the PR added or changed three times at once, with no shared test slots.
- Left out: D-066, a deferral. And D-052: it is a browser test in `relay/test/browser/`, which the probe does not run.

**`test-helpers`: the `room-settings` probe.** Category "Test environment leak". Source: D-135, D-092.
- In both, `relay/test/helpers.js` passed the shell's room settings to each test relay. The tests passed on CI and failed in an office session. PR 92 (a link of D-135) and PR 8 (the link of D-092) both changed `relay/test/helpers.js`.
- Match: `relay/test/helpers.js`. `relay/test/run.js` is left out, because only D-135 points to it.
- Needs: a probe that runs the tests that start relays, with a room's settings set.

**`needs-you`: a test that fails before the change.** Category "Stale state". Source: D-120, D-053.
- Both showed an old hand-over after the state had moved on, and both came from PR 48, which made the Needs you list in `relay/needs-you-plan.js`, `relay/needs-you.js` and `office/needs-you.js`.
- Match: those three files.
- Needs: the tests on the base and the head, and a test that fails before the change, for every PR (`failing-before` with no `when`). PR 48 added these files, so it was a feature. But Building58 PRs have no labels, and the pinned release `v0.1.0` has no `source_paths` to see a feature (spec 9.1), so `when: [fix, feature]` would not have applied to PR 48. The cost is that a refactor here is asked for a failing test too. Once a newer release is pinned, the setup note says how to narrow it with `source_paths`.
- Left out: D-060 (from PR 44, in `relay/autopilot.js`) and D-099 (from PR 12, in `relay/terminal.js`). Each is the only stale-state defect from its file.

### Categories with no rule

- **Missing feature path** (8 defects). Only D-126 (PR 81, `relay/reviews.js`) and D-070 (PR 64, `relay/pr-comments.js`) have a kept link, and they share no file. The only glob that covers both is `relay/**`, and the starter's `code` kind already asks a fix there for a test that fails before.
- **Race condition** (2 defects). Only D-145 has a kept link.
- **Missing retry backoff, Inconsistent rules across views, Incomplete integration** (1 defect each).

### edd-platform

No draft. Its history run found 2 fix PRs and no escaped defect (phase-a-history.md), so no rule has two defects behind it. Its setup note keeps the starter policy. It can get rules once the person picks its fix PRs, as for Building58.

## The probes on real commits

Each probe ran by hand on real Building58 commits, from a clean worktree with `npm ci`, and then the whole policy ran in `exhibit check`.

**The `room-settings` probe catches D-135.**

| Commit | Room settings | Tests | Failed |
|---|---|---|---|
| `main` 145143a | set, but not `OFFICE_HOOK_URL` or `OFFICE_TICKET_TOKEN` | 75 | 0 |
| f1da5ba, just before PR 135's fix | set, as in the probe | 58 | 27 |
| f1da5ba, just before PR 135's fix | none (`env -i`) | 73 | 0 |

The run before the fix took 11 minutes, because many relays timed out. Without the settings, the same tests pass, so the settings are the cause. The commit before the fix has no `room-env.test.js`, so those runs used the other three files. The first run was made before `OFFICE_HOOK_URL` and `OFFICE_TICKET_TOKEN` joined the probe, because D-135's fix PR names them as the settings that leaked. The probe with both ran in `exhibit check` below.

**The policy reads in the pinned release.** The setup note pins Exhibit `v0.1.0`. Its `readPolicy`, from a worktree of the tag, reads the policy with no error and finds the kinds `code`, `docs`, `relay-tests`, `test-helpers` and `needs-you`. An earlier draft of this PR also set `test_timeout_seconds` and `source_paths`. `v0.1.0` refused both, so they wait for a newer release (setup note).

**`exhibit check` on PR 135 with the policy.** This run used Exhibit from `main` and the earlier draft, which also had `test_timeout_seconds: 900` and `source_paths`, and a `load` probe without `set -e`. `exhibit check` reads the policy from the base commit (spec 8.1), so the run used two local commits in the clone, never pushed: PR 135's merge base (`d64a92a`) with the draft added as `evidence-257.yml`, and PR 135's head with the same file on top of it. The diff between them is PR 135's 9 files and nothing else.

```
exhibit check --base 1fe8769 --head 2f15aac --policy evidence-257.yml
Verdict: needs_person. 1 gap, listed with how to fix it in .exhibit/summary.md.
```

It ran from 15:09:06Z to 15:42:26Z on 2026-11-21, on a Mac.

- It read the policy with no error. The kinds were `code`, `relay-tests` and `test-helpers`. It was a feature, since the PR adds `relay/test/room-env.test.js` under `source_paths`. Without `source_paths` it would not be one, and nothing in this run depends on that.
- `probe load`: met. It ran the 6 test files that the PR added or changed, three copies at once. Each copy passed (55 tests).
- `probe room-settings`: met. 75 tests, none failed.
- `tests-before-after`: failed, for two reasons:
  - The base run passed the 900-second limit, and Exhibit stopped it. The test command sends each file's output to `/dev/null`, so the log does not name the file. See the hang below.
  - Two tests failed on the head, also when run again. Alone, at PR 135's head, both pass with a clean env. `lead-refresh.test.js` fails with this session's room settings (`OFFICE_*`, `RELAY_*`, `CLAUDE_CODE_*`), which the policy's test command does not take away (setup note). `review-desk.test.js` passes alone with those settings too, so it failed from the load of six files at once. The first is a test environment leak and the second a flaky test, the two categories that the probes are for. On CI there are no room settings.

**A hang in the first check run.** The first `exhibit check` on PR 135 ran Exhibit from before ticket 178, which has no time limit for the test command, and used `f1da5ba` as the base. On the base, `relay/test/lead-check.test.js` hung at 0% CPU from about 11:08Z, past its 120-second `--test-timeout`, while every other file had ended. The Lead saw it at 11:48Z, and the run was stopped by hand at 11:48:57Z. In the second run, `test_timeout_seconds: 900` stopped the base run after 15 minutes. The policy can set that limit only once a newer release is pinned.

**The `load` probe after the review of this PR.** The review found that the probe passed when a step before the tests failed: `code` stayed 0 and no test ran. It now starts with `set -e`, and its steps are separate commands, since `sh` ignores a failure inside an `&&` list. Runs of the committed command, on 2026-11-21:

- In a git repo with no `origin/main`: `fatal: Not a valid object name origin/main`, exit 128.
- At PR 135's head (the commit from the check run), with a `package.json` that `npm ci` cannot install: exit 1, and no test ran.
- At the same commit, as it is: exit 1 after 4 minutes 43 seconds. Each copy ran the 6 changed files. `review-link.test.js` failed in two copies ("the person is talking to it, so it stays") and `games.test.js` in one ("Timed out waiting for the game to get abort"). In the check run, the same probe on the same commit passed. So the probe is not the same each time. It finds tests that fail under load, which is what it is for. But it can ask a PR to fix a test that it only touched.

## What comes next

- The Building58 room opens one PR with `examples/building58/evidence.yml` as its `evidence.yml`, as the setup note says.
- The backtest (S8) reads `building58-labels.jsonl` and this policy. Every rule here names its defects in `source`, so the leak check can drop them.
