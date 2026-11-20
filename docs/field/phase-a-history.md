# Field test Phase A: the first history runs

Ticket 256. Spec section 12, Phase A.

Exhibit had never run on the field repos. This page records the first full `exhibit history` run on Building58 and on edd-platform. It is the baseline for the next steps: the person labels the escaped defects (S3), and the backtest (S8) and the first policy use them.

## How the runs were made

- Exhibit at `main` 6a3c549, run from source in its own checkout.
- Each repo ran in a fresh clone, with the real repo as `origin`, so SZZ could run `git blame`. The clones are in `~/code/repo/exhibit-phase-a/building58` and `~/code/repo/exhibit-phase-a/edd-platform`. The main checkouts of the two repos were not used.
- Each clone has an `evidence.yml` for the run only. It is listed in the clone's `.git/info/exclude`, as are `.exhibit/` and `run.log`, so nothing goes into the field repos. The two files are below.
- The command: `GITHUB_TOKEN=$(gh auth token) exhibit history --repo bfalkowski/<name>`, with no `--limit`. The person allowed full history for Phase A on 2026-11-20.
- `gh api rate_limit --jq '.resources.core, .resources.graphql'` ran before and after each run. The token is shared with other sessions, so the change in `used` can be a little more than the run's own count.
- Each clone keeps what the run wrote: `.exhibit/history.jsonl`, `.exhibit/report.md`, `.exhibit/report.html`, `run.log`, `rate-before.txt` and `rate-after.txt`.

## Results

| | Building58 | edd-platform |
|---|---|---|
| Merged PRs read | 146 (merged 2026-11-10 to 2026-11-20) | 112 (merged 2026-11-08 to 2026-11-12) |
| Fix PRs | 34 | 2 |
| Escaped defects (fix PRs that SZZ linked) | 20 | 0 |
| Escaped defects with a strong link (confidence 0.5 or more) | 8 | 0 |
| Links, and different introducing PRs | 49 links to 33 PRs | none |
| Fix PRs with no link | 14 | 2 |
| Run time | 28 s | 15 s |
| GitHub REST requests | 38, of which 7 got a 304 | 4 |
| GitHub GraphQL queries | 3, 9 points | 3, 9 points |
| REST left, before and after | 4,293 and 4,259 | 4,236 and 4,227 |
| GraphQL left, before and after | 4,919 and 4,919 | 4,917 and 4,914 |

Both reports say the history is weak. Building58: only 8 of 20 escaped defects have a strong link. edd-platform: only 2 fix PRs, and SZZ linked neither.

### Counts by kind of change

A PR can match more than one kind, so the counts add up to more than the number of PRs. The kinds come from the run-only `evidence.yml` files below.

Building58:

| Kind | Merged PRs | Fix PRs | Escaped defects (kind of the fix) | Introducing PRs |
|---|---|---|---|---|
| relay | 140 | 34 | 20 | 33 |
| docs | 108 | 18 | 13 | 29 |
| office | 53 | 3 | 3 | 13 |
| tooling | 15 | 0 | 0 | 5 |

edd-platform:

| Kind | Merged PRs | Fix PRs |
|---|---|---|
| apps | 102 | 1 |
| docs | 46 | 1 |
| scripts | 10 | 1 |
| packages | 5 | 1 |
| agent-config | 2 | 0 |
| default (no kind matched) | 1 | 0 |

### Why fix PRs got no link

- Building58: 12 of the 14 fix PRs blamed only lines from one commit, `9a7e34b` "Building58" of 2026-11-10. That commit brought in the code before the repo used PRs, so it is in no merged PR. All 249 unlinked lines of the fix PRs come from it. The other 2 (PR 95 and PR 69) deleted or changed no line, so there was nothing to blame.
- edd-platform: PR 28 blamed 18 lines, all from commits in no merged PR. PR 108 deleted or changed no line.

## Fix signals

The PRs in both repos have no labels, and their titles name a bug by its symptom after a key, such as "T-170: tasks.test.js can hang in CI". So the default fix signals find almost no fixes.

- Building58 uses the person's list of 33 fix PRs from `~/code/repo/rooms/building58-fix-prs.md` (19 product bugs and 14 flaky or broken tests), as `pr:` signals. `title:fix` also matched PR 30, "Fix the manager's door and give him a keyboard", which is not on the list. That makes 34.
- edd-platform has no such list yet. Its run used `title_after_key:fix` and `revert`, which found 2 fix PRs. Its titles hold about 30 more PRs that may be fixes, such as "T-90: Runner: provider errors on agents with tools crash the whole suite run".

A first trial run on Building58 used the signals `[label:bug, title:fix, title_after_key:fix, branch:fix/, revert]`. It found 2 fix PRs, and one of them, PR 111 "T-338: Fix small review findings in the same PR instead of filing follow-ups", is a change of process, not a bug fix. It made 10 REST requests and 3 GraphQL queries. Its files are in `~/code/repo/exhibit-phase-a/trial-run-own-signals`.

## Is edd-platform useful for Phase A?

Not yet. Use Building58 alone for now.

- edd-platform has 2 fix PRs and no escaped defect.
- Its main branch has 263 first-parent commits. 151 of them were pushed from June to August 2026, before the repo used PRs. The 112 PRs were all merged from 2026-11-08 to 2026-11-12. So many lines that a fix changes come from commits in no PR, and SZZ can link them to nothing. PR 28 shows this already.
- It can join when the person picks its fix PRs, as for Building58. Even then, expect fewer links than on Building58.

## Exhibit issues the runs showed

- The spec's table of commands lists `exhibit history` without `--repo`, but the command stops without it, also inside a clone whose `origin` names the repo. Filed as ticket 264.

No run failed, and no run came near the rate limit.

## The run-only evidence.yml files

Building58:

```yaml
version: 3

settings:
  test_command: "npm test"
  # The person's list, from ~/code/repo/rooms/building58-fix-prs.md (33 fix PRs).
  fix_signals: [label:bug, title:fix, branch:fix/, pr:131, pr:129, pr:128, pr:126, pr:122, pr:120, pr:119, pr:118, pr:101, pr:99, pr:96, pr:95, pr:93, pr:92, pr:91, pr:89, pr:88, pr:84, pr:78, pr:71, pr:70, pr:69, pr:66, pr:61, pr:60, pr:59, pr:58, pr:56, pr:53, pr:52, pr:49, pr:47, pr:42]

kinds:
  relay:
    match: ["relay/**"]
    risk: high
    needs: [tests-before-after]
  office:
    match: ["office/**", "shared/**"]
    risk: high
    needs: [tests-before-after]
  tooling:
    match: [".github/**", ".githooks/**", "eslint.config.js", "eslint-local.js", "eslint-suppressions.json", "package.json", "package-lock.json", ".gitignore"]
    risk: medium
    needs: [tests-before-after]
  docs:
    match: ["docs/**", "*.md", "index.html"]
    risk: low
    needs: [tests-before-after]

default:
  risk: medium
  needs: [tests-before-after]
```

edd-platform:

```yaml
version: 3

settings:
  test_command: "npm test"
  fix_signals: [label:bug, title:fix, title_after_key:fix, branch:fix/, revert]

kinds:
  apps:
    match: ["apps/**"]
    risk: high
    needs: [tests-before-after]
  packages:
    match: ["packages/**"]
    risk: high
    needs: [tests-before-after]
  scripts:
    match: ["scripts/**", ".github/**", "docker-compose*.yml", ".env.example", "package.json", ".gitignore"]
    risk: medium
    needs: [tests-before-after]
  agent-config:
    match: [".claude/**", ".beads/**", "CLAUDE.md"]
    risk: medium
    needs: [tests-before-after]
  docs:
    match: ["docs/**", "README.md", "examples/**", "LICENSE"]
    risk: low
    needs: [tests-before-after]

default:
  risk: medium
  needs: [tests-before-after]
```
