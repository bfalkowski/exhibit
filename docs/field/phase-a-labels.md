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
- The person skipped one defect: D-071 ("1 tasks are being built"). A review of PR 50 found it and filed it as a follow-up, so it was known at review. It is a deferral, not a policy miss.
- The labels file is copied here as [building58-labels.jsonl](building58-labels.jsonl), so the backtest can read it. The spec has no line for a skipped defect (section 8.4), so D-071 is only in this page. Ticket 355 asks for a way to record a skip in the file.

## Results

| | Count |
|---|---|
| Escaped defects | 27 |
| Labeled | 26 |
| Skipped | 1 (D-071) |
| With at least one link the person kept | 18 |
| With every link rejected (a real bug with no known introducing PR) | 8 |
| SZZ links kept, of the links of the 26 labeled defects | 26 of 70 |

Most rejected links blamed an export list, an import, a list of kinds, a manual paragraph, or a PR that only removed comments. The bug's own lines often came from commit `9a7e34b`, which is in no PR (phase-a-history.md).

### How often the person kept Claude's draft

`exhibit label --claude` printed this at the end of the run:

> Claude's drafts in the whole labels file: 26 shown. 25 kept unchanged, 1 edited, 0 replaced. The person kept 96% of the drafts unchanged (25 of 26, 95% interval 80% to 100%).

The one edit was D-144: the person changed the category from "Race condition" to "flaky test", the name their fix list uses. Claude then used "flaky test" for the later flaky tests by itself.

### Counts by category

| Category | Defects | With a kept link |
|---|---|---|
| Missing feature path | 8: D-140, D-126, D-122, D-119, D-118, D-070, D-059, D-047 | 2: D-126, D-070 |
| flaky test | 7: D-144, D-139, D-136, D-131, D-088, D-066, D-052 | 7 |
| Stale state | 4: D-120, D-099, D-060, D-053 | 4 |
| Race condition | 2: D-145, D-056 | 1: D-145 |
| Test environment leak | 2: D-135, D-092 | 2 |
| Missing retry backoff | 1: D-148 | 0 |
| Inconsistent rules across views | 1: D-061 | 1 |
| Incomplete integration | 1: D-030 | 1 |

## The first policy

The rule for keeping a rule comes from ticket 199 and spec section 9.9: a rule needs at least two labeled defects of one category, each with a link the person kept. The diff must show when it applies. So the `match` of a rule is only the files that the introducing PRs of at least two of those defects changed, where the blamed lines are.

### Rules kept

**`relay-tests`: the `load` probe.** Category "flaky test". Source: D-144, D-139, D-136, D-131, D-088, D-066.
- Each was a test that raced a timer or a kept-alive connection. It passed alone and failed on a busy machine. Each introducing PR (109, 129, 88, 47, and the 7 of D-088) changed a file in `relay/test/*.test.js`.
- Match: `relay/test/*.test.js`.
- Needs: a probe that runs each test file the PR added or changed three times at once, with no shared test slots.
- Left out: D-052. It is a browser test in `relay/test/browser/`, which the probe does not run.

**`test-helpers`: the `room-settings` probe.** Category "Test environment leak". Source: D-135, D-092.
- In both, `relay/test/helpers.js` passed the shell's room settings to each test relay. The tests passed on CI and failed in an office session. PR 92 (a link of D-135) and PR 8 (the link of D-092) both changed `relay/test/helpers.js`.
- Match: `relay/test/helpers.js`. `relay/test/run.js` is left out, because only D-135 points to it.
- Needs: a probe that runs the tests that start relays, with a room's settings set.

**`needs-you`: a test that fails before the change.** Category "Stale state". Source: D-120, D-053.
- Both showed an old hand-over after the state had moved on, and both came from PR 48, which made the Needs you list in `relay/needs-you-plan.js`, `relay/needs-you.js` and `office/needs-you.js`.
- Match: those three files.
- Needs: the tests on the base and the head, and `failing-before` with no `when`. Building58 PRs have no labels, so Exhibit never sees a feature (spec 9.1), and `when: [fix, feature]` would not have applied to PR 48.
- Left out: D-060 (from PR 44, in `relay/autopilot.js`) and D-099 (from PR 12, in `relay/terminal.js`). Each is the only stale-state defect from its file.

### Categories with no rule

- **Missing feature path** (8 defects). Only D-126 (PR 81, `relay/reviews.js`) and D-070 (PR 64, `relay/pr-comments.js`) have a kept link, and they share no file. The only glob that covers both is `relay/**`, and the starter's `code` kind already asks a fix there for a test that fails before.
- **Race condition** (2 defects). Only D-145 has a kept link.
- **Missing retry backoff, Inconsistent rules across views, Incomplete integration** (1 defect each).

### edd-platform

No draft. Its history run found 2 fix PRs and no escaped defect (phase-a-history.md), so no rule has two defects behind it. Its setup note keeps the starter policy. It can get rules once the person picks its fix PRs, as for Building58.

## The probes on real commits

PROBE_RESULTS

## What comes next

- The Building58 room opens one PR with `examples/building58/evidence.yml` as its `evidence.yml`, as the setup note says.
- The backtest (S8) reads `building58-labels.jsonl` and this policy. Every rule here names its defects in `source`, so the leak check can drop them.
