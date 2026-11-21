# Five planted bugs in Building58

Ticket 258. Spec sections 12 ("Planted faults") and 14.

The 1.0 target is that Exhibit gives `needs_person` on 90% or more of the planted bugs (canaries). The hidden canary job of slice S9 does not exist yet. So this page records a small first try by hand: five bugs planted in Building58, each with a new test that passes but misses the bug, as a real builder PR might have. Then `exhibit check` ran on each one.

**Result: 2 of 5 caught.** Both catches came from mutation. The three misses show three things that mutation on the changed lines cannot see: code that was removed, a wrong answer that every test agrees with, and a wrong variable.

## How the runs were made

- Exhibit at `main` 3f93878, run from source.
- A fresh clone of Building58 at `main` 145143a, in a scratch folder. Its push URL was set to a word that is not a remote, so nothing could be pushed. No PR was opened.
- One commit on the clone's `main` (dd76c8a) added the policy as `evidence-canary.yml`: the starter policy from ticket 193 ([examples/building58/evidence.yml](../../examples/building58/evidence.yml)), plus `mutation: { min: 0.8 }` on the `code` kind and the mutation settings from ticket 260's Building58 run. Ticket 257, the policy from Building58's own defects, is not done yet. The file is [canaries/evidence-canary.yml](canaries/evidence-canary.yml).
- Each canary is one commit on its own branch from dd76c8a. The patches are in [canaries/](canaries/), as `git format-patch` wrote them. dd76c8a is only in the scratch clone. To run them again, copy [canaries/evidence-canary.yml](canaries/evidence-canary.yml) to the top of a clone of Building58 at 145143a, commit it, and apply each patch on that commit with `git am`.
- Each run, one at a time, so the runs did not slow each other:

  ```
  env -i PATH="$PATH" HOME=<empty folder> TEST_SLOTS=0 caffeinate -i \
    node bin/exhibit.js check --base main --head <branch> --policy evidence-canary.yml
  ```

- The Mac did not sleep during the runs (`pmset -g log`), and no mutant in any run was killed by a timeout. A busy machine can only add kills by timeouts, so the counts below are not raised by load.
- Without `--pr`, Exhibit knew only the branch name. So only canary 4, on a `fix/` branch, was a fix, and only it needed `failing-before`.

## The canaries

| | Change | Kind of change | Planted bug | The new test | Verdict | Gaps in `evidence.json` |
|---|---|---|---|---|---|---|
| 1 | `relay/ticket-twins.js`: move the "close enough" test into a helper, `closest` | `code`, a refactor | Off by one: `best.both >= MIN_WORDS` became `> MIN_WORDS`, so two tickets that share exactly 2 words are no longer twins | Calls `closest` with 4 and 1 shared words | `needs_person` | `mutation: failed`, 12 of 18 (0.67) |
| 2 | `relay/pr-watch-plan.js`: `lateness` gets a default time | `code`, a feature | Wrong default: the comment says half an hour, the code says `30 * 1000` (30 seconds) | Late after 2 hours and at `LATE_MS`, not late at 0 | `needs_person` | `mutation: failed`, 1 of 2 (0.5) |
| 3 | `relay/merge-hold.js`: say when `git status` fails | `code`, a feature | Missing error path: `git rev-list` is now outside the `try`, so a checkout with no commits throws | A folder that is not a checkout, which still fails at `git status` | `meets_policy` | none (mutation met, 23 of 27) |
| 4 | `relay/ticket-order.js`: a place near a ticket outside the work order goes last | `code`, a fix (`fix/` branch) | Off by one in the fix: `group.length - 1`, so "before" such a ticket lands second to last | Tries "after" only. It fails on the base | `meets_policy` (first run: `error`) | none (failing-before met, mutation met, 10 of 10) |
| 5 | `office/holidays.js`: new `daysLeft`, the days the decorations still show | `code`, a feature | Wrong variable: `to - from + 1` where `to - today + 1` was meant | Checks the first day of a window, where `from` is today, and a day with none | `meets_policy` | none (mutation met, 9 of 9) |

`tests-before-after` was met on every run, and every test passed on every head. The planted bugs are real. A script ran the same input on `main` and on each branch:

| Canary | Input | `main` | Canary | Right answer |
|---|---|---|---|---|
| 1 | "Radio volume" against "Radio volume too loud" | twin T-1 | no twin | twin T-1 |
| 2 | `lateness` after 1 minute, with no time set | (no default) | late | not late until 30 minutes |
| 3 | `unsavedWork` on a fresh `git init` | a message | throws | a message |
| 4 | move A before a Started ticket, in A, S, B, C | (not last) | B, A, C | B, C, A, as the fix's comment says |
| 5 | `daysLeft` on 2026-11-20 | (no function) | 16 | 8 |

## What Exhibit named

### Canary 1: caught

```
$ exhibit check --base main --head canary/1-twins-refactor --policy evidence-canary.yml
Verdict: needs_person. 1 gap, listed with how to fix it in .exhibit/summary.md.
exit 1 after 1350 s

- mutation (from code): failed. Catch rate 0.6667 (12 of 18 mutants killed, 0 of them by a timeout; 95% interval 0.4099 to 0.8666).
  - Survived, though a test ran the line:
    - relay/ticket-twins.js:32 EqualityOperator: `byTitle.share >= byAll.share` became `byTitle.share > byAll.share`
    - relay/ticket-twins.js:33 ConditionalExpression: `best.share >= MIN_SHARE` became `true`
    - relay/ticket-twins.js:33 EqualityOperator: `best.share >= MIN_SHARE` became `best.share > MIN_SHARE`
    - relay/ticket-twins.js:33 LogicalOperator: `best.share >= MIN_SHARE && best.both > MIN_WORDS` became `best.share >= MIN_SHARE || best.both > MIN_WORDS`
    - relay/ticket-twins.js:33 ConditionalExpression: `best.both > MIN_WORDS` became `true`
    - relay/ticket-twins.js:33 EqualityOperator: `best.both > MIN_WORDS` became `best.both >= MIN_WORDS`
```

The last survivor is the fix of the planted bug. A person who reads the list sees it.

### Canary 2: caught, by a small margin

```
$ exhibit check --base main --head canary/2-late-default --policy evidence-canary.yml
Verdict: needs_person. 1 gap, listed with how to fix it in .exhibit/summary.md.
exit 1 after 1382 s

- mutation (from code): failed. Catch rate 0.5 (1 of 2 mutants killed, 0 of them by a timeout; 95% interval 0.0125 to 0.9875).
  - Survived, though a test ran the line:
    - relay/pr-watch-plan.js:51 ArithmeticOperator: `30 * 1000` became `30 / 1000`
```

The survivor points at the right line, but it does not say that the unit is wrong. With only 2 mutants, one survivor decides the verdict. A test that checked `LATE_MS / 1000 === 30` would kill the survivor and still miss the bug.

### Canary 3: missed

```
$ exhibit check --base main --head canary/3-unsaved-count --policy evidence-canary.yml
Verdict: meets_policy. No gaps.
exit 0 after 1519 s

- mutation (from code): met. Catch rate 0.8519 (23 of 27 mutants killed, 0 of them by a timeout; 95% interval 0.6626 to 0.9582).
  - Survived, though a test ran the line:
    - relay/merge-hold.js:37 ConditionalExpression: `n === 1` became `true`
    - relay/merge-hold.js:37 ConditionalExpression: `n === 1` became `true`
  - Survived, because no test ran the line:
    - relay/merge-hold.js:37 StringLiteral: `'s'` became `""`
    - relay/merge-hold.js:37 StringLiteral: `'are'` became `""`
```

The bug is code that is not there any more: the `catch` around `git rev-list`. Mutation changes only code that is on the head, so no mutant can stand for it. The survivors are on a line that only moved. Ticket 299.

After ticket 299, Exhibit names lost error paths (spec 9.5): calls that a `try` with a `catch` covered on the base, and that no `try` covers on the head. The same canary, run again with the patch on a new clone (commit 95b5d8f, the same change with another commit date):

```
$ exhibit check --base main --head canary/3-unsaved-count --policy evidence-canary.yml
Verdict: needs_person. 1 gap, listed with how to fix it in .exhibit/summary.md.
exit 1 after 1512 s

- mutation (from code): missing. Catch rate 0.8519 (23 of 27 mutants killed, 0 of them by a timeout; 95% interval 0.6626 to 0.9582).
  ...
  - Calls that a try with a catch covered on the base, and no try covers on the head:
    - relay/merge-hold.js:36 in unsavedWork: `Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes'))`
```

### Canary 4: missed

The first run gave `error`, because a test that the canary does not touch failed in Stryker's first run:

```
$ exhibit check --base main --head fix/canary-4-place-near-missing-target --policy evidence-canary.yml
Verdict: error. 1 gap, listed with how to fix it in .exhibit/summary.md.
exit 2 after 1838 s

- failing-before (from code): met. Tests that fail on the base and pass on the head: relay/test/review-desk.test.js > test > reviews wait and no session may be stopped: nobody is stopped, Needs you names the wait, and each review starts once a session may be stopped (fails on the base); relay/test/ticket-order.test.js > test > a place after a target that movable leaves out goes last in the group (fails on the base).
- mutation (from code): error. Stryker exited with code 1 before it finished.
```

A second run of the same commits:

```
$ exhibit check --base main --head fix/canary-4-place-near-missing-target --policy evidence-canary.yml
Verdict: meets_policy. No gaps.
exit 0 after 2266 s

- tests-before-after (from code): met.
- failing-before (from code): met. Tests that fail on the base and pass on the head: relay/test/ticket-order.test.js > test > a place after a target that movable leaves out goes last in the group (fails on the base).
- mutation (from code): met. Catch rate 1 (10 of 10 mutants killed, 0 of them by a timeout; 95% interval 0.6915 to 1).
```

An `error` is not a catch: the spec asks for `needs_person` on each canary. The real verdict is `meets_policy`. The existing tests kill every mutant of the changed lines. The bug is a case that no test tries ("before" a ticket outside the work order), so the lines that are there are well tested, and the gap is in the inputs. Ticket 300.

The first run also showed two problems in Exhibit:

- `failing-before` listed the `review-desk` test as the PR's, though the PR did not change its file. That test failed twice in the run on the base with the PR's test files, and passed in the plain base run, and the rule in section 9.4 takes any test whose result changed between those two runs as the PR's. Here it did no harm, because the real test qualified too. Alone, it would be a false pass. Ticket 302.
- One test that failed by chance in Stryker's first run made the requirement `error`. The test runs in section 9.3 try a failed test again, but the mutation run does not. Ticket 303.

### Canary 5: missed

```
$ exhibit check --base main --head canary/5-days-left --policy evidence-canary.yml
Verdict: meets_policy. No gaps.
exit 0 after 1290 s

- mutation (from code): met. Catch rate 1 (9 of 9 mutants killed, 0 of them by a timeout; 95% interval 0.6637 to 1).
```

Stryker has no mutator that puts one variable in place of another. So no mutant puts `today` where `from` is, and each test point is the first day of a window (or a day with no decorations), where both give the same answer. Ticket 301.

## What this says

- Mutation catches a weak test of a line that is there and has a wrong operator or number (canaries 1 and 2). It cannot see removed code, a case that no test tries, or a swapped variable (canaries 3 to 5).
- Without mutation, all five would get `meets_policy`: every other requirement was met on each one.
- 2 of 5 is far from 90%. Five canaries are too few for a real rate: the 95% interval for 2 of 5 is 0.05 to 0.85. The hidden canary job should plant many more, and of each kind here.
- A run took 21 to 38 minutes on the Mac, almost all of it the two full Building58 test runs (three for the fix). Stryker took 2 s to 3.5 minutes.

## Tickets filed

- 299: canary 3, a change that drops a `try`/`catch` makes no mutant.
- 300: canary 4, an off-by-one in a fix that its test tries in one direction only.
- 301: canary 5, a wrong variable makes no mutant that survives.
- 302: `failing-before` counts a test that the PR did not change when it fails by chance.
- 303: mutation gives `error` when one test fails by chance in Stryker's first run.
