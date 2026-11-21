# Exhibit spec

Status: draft 0.1, 2026-11-18. Nothing is built yet.
Owner: Bryan Falkowski.
Explainer with diagrams: [docs/index.html](index.html).

## 1. Summary

Exhibit decides what evidence a pull request needs, collects that evidence, checks that it is strong, and learns its rules from the bugs that got through. It is a CLI and a GitHub Action. It needs no server.

## 2. The problem

- Agents open more pull requests than a person can read. A person who approves on autopilot is a check on paper only.
- "Tests pass" says nothing about whether the tests are strong. A weak test passes too.
- Teams write evidence rules from guesses. Nobody checks whether the rules would have caught the bugs that already got through.
- There is no measured answer to the question "when can we stop reading the code for this kind of change?"

## 3. Goals

| ID | Goal |
|---|---|
| G1 | Learn evidence rules from a repo's own PR history. |
| G2 | Check each PR against those rules, with evidence that anyone can verify by running it again. |
| G3 | Measure how strong the checks are, not only whether they pass. |
| G4 | Prove the rules on history before anyone trusts them. |
| G5 | For each kind of change, give the numbers a person needs to decide a rung on the trust ladder. |
| G6 | Run on any GitHub repo with one command and no server. |

## 4. Non-goals

- Exhibit does not judge style or design.
- Exhibit does not replace CI or tests. It runs them and reads their results.
- Exhibit never merges a PR and never turns on a rung. It gives a verdict and numbers. A person or a merge rule acts on them.
- Exhibit is not an LLM code reviewer. Claude only drafts error-analysis codes, and a person confirms each one.
- No hosted service and no dashboard in version 1.

## 5. Users

| User | What they do with Exhibit |
|---|---|
| Builder session (agent) | Runs `exhibit check` before it opens a PR and fixes the gaps it lists. |
| Reviewer session (agent) | Reads `evidence.json` first and spends its review on the gaps. |
| Maintainer (person) | Labels escaped defects, approves policy changes, reads the blind sample, decides rungs. |
| Stranger | Runs `exhibit history` on their own repo and reads the report. |

## 6. Words

| Word | Meaning |
|---|---|
| Kind of change | A named group of changes, matched by file paths, such as `relay-core` or `manual`. |
| Policy | The file `evidence.yml`. It says what evidence each kind of change must show. |
| Evidence item | One requirement in the policy, such as a test run or a probe. |
| Exhibit | The evidence collected for one PR at one head commit. It is written as `evidence.json`. |
| Verdict | `meets_policy`, `needs_person` or `error`. |
| Escaped defect | A bug that merged and was fixed later. |
| Introducing PR | The PR that added the lines a fix changed. For a revert, the PR that the revert takes back. |
| Revert | A PR that takes back an earlier PR, such as one made with GitHub's Revert button or with `git revert`. It names the work it takes back, so SZZ links it with no blame (section 9.2). |
| Policy miss | An escaped defect whose introducing PR got `meets_policy`. |
| False demand | A requirement that was missing on a PR that turned out to be fine. |
| Catch rate | Killed mutants divided by killed plus survived mutants, on the changed lines. |
| Shadow mode | Exhibit gives its verdict, but nothing waits on it. |
| Blind sample | Merged PRs picked at random that a person reads without seeing the verdict first. |
| Rung | One step on the trust ladder, for one kind of change. Only a person turns a rung on. |
| Forge | The service that hosts the repo and its PRs, such as GitHub. |
| Reply cache | The folder where Exhibit saves GitHub replies with their ETags, so a later run can get a 304 instead of a full reply (section 8.6). |

## 7. Commands

All commands accept `--json` for machine output and `--repo owner/name`, except `exhibit label`, which reads only local files, and `exhibit publish`. Neither takes `--repo`. `exhibit publish` needs no repo name, because it pushes to `--remote`. With `--comment`, it reads the repo from the exhibit. Each command exits 0 on success and 2 on a tool error, or on any other failure, such as a bug in Exhibit. `exhibit check` also exits 1 for `needs_person` (section 9.8).

| Command | What it does |
|---|---|
| `exhibit init` | Writes a starter `evidence.yml` and example workflow files. |
| `exhibit history [--since DATE] [--limit N] [--full] [--no-cache]` | Exports merged PRs to `.exhibit/history.jsonl`, runs SZZ, and writes a report. When the file is there, it reads only what is new (section 8.3). `--full` reads every PR again. `--no-cache` turns off the reply cache (section 8.6). |
| `exhibit label [--json] [--claude]` | Shows each escaped defect that has no code yet, one at a time, with its SZZ evidence. The person types a code, a category and the evidence that would have caught it, or skips the defect. Each label goes to `.exhibit/labels.jsonl` at once (section 8.4). With `--claude`, Claude drafts a code and a category first, and the person confirms the draft, edits it, or throws it away (section 9.11). |
| `exhibit policy suggest` | Drafts policy rules from the labeled categories and prints them as a diff to `evidence.yml`. It never writes the file itself. |
| `exhibit backtest [--from DATE] [--rerun]` | Applies the policy to PRs merged after a date and reports caught, missed and false demands for each kind of change. |
| `exhibit check --base REF [--head REF]` or `exhibit check --pr N --repo owner/name`, each with `[--policy FILE] [--shadow]` | Works out what the change needs, collects the evidence, and writes `.exhibit/evidence.json` and `.exhibit/summary.md` (sections 8.2 and 9.8). Exits 0 for `meets_policy`, 1 for `needs_person` and 2 for `error`. When it fails before it has a verdict, such as on a bad argument, a bad policy or a commit that is not in the clone, it writes no `evidence.json`, and `summary.md` says that the verdict is `error` and why. It reads the policy from the base commit, not from the files on disk (section 8.1). `--policy` reads the policy from that path in the repo in place of `evidence.yml`, and a change to that file is then the policy change (section 8.2). `--shadow` is shadow mode: the run and the files are the same, but the exit code is 0 for every verdict, `error` too, and `summary.md` says so (section 10). `--head` is `HEAD` when left out. With `--pr`, the forge gives the base, the head, and the PR's title, body, labels and branch, and `GITHUB_TOKEN` must be set. Without `--pr`, only the local branch name is known for the fix signals. Both commits must be in the clone. |
| `exhibit publish --evidence FILE [--policy FILE] [--storage data-branch\|local] [--data-branch NAME] [--remote NAME] [--local-path DIR] [--comment] [--enforce]` | Stores one exhibit, the `evidence.json` that `exhibit check` wrote, at `prs/<number>/<head-sha>.json` (section 9.12). It checks the file against the exhibit schema first, and an invalid file, or one with no PR number, gives exit 2 and stores nothing. It never runs code from the PR, so it is the step that can have write access. `--policy` reads the settings from that path in the repo in place of `evidence.yml`. `--storage` picks the place and wins over `settings.storage`. `--remote` is `origin` when left out. Storing the same exhibit again changes nothing and exits 0. With `--comment`, it then posts a short summary of the exhibit as one comment on the PR, or updates the comment it posted before (section 9.12). It reads the PR from the exhibit's `repo` and `pr`, and `GITHUB_TOKEN` must be set. Without `--enforce`, the comment says that it is shadow mode. Without `--comment`, nothing is posted, and `--enforce` changes nothing. |
| `exhibit verify FILE` | Runs the claims in an `evidence.json` again and reports any that do not hold. |
| `exhibit trace --pr N` | Runs after a merge. If the PR is a fix, it finds the introducing PRs and records any policy miss. |

## 8. Files and formats

### 8.1 `evidence.yml`

```yaml
version: 3
settings:
  test_command: "npm ci && node --test --test-reporter=junit --test-reporter-destination=.exhibit/junit.xml test/*.test.js"
  test_results: ".exhibit/junit.xml"
  fix_signals: [label:bug, title:fix, branch:fix/, tracker:jira]
  source_paths: ["relay/**", "src/**"]
  jira:
    site: https://acme.atlassian.net
    issue_types: [Bug]
    found_field: customfield_10042
    escaped_values: [Production]
  mutation_budget_seconds: 300
  mutation_setup: "npm ci"
  mutation_test_files: ["test/**/*.test.js"]
  probe_timeout_seconds: 600
  storage: data-branch
  data_branch: exhibit-data
kinds:
  relay-core:
    match: ["relay/supervisor.js", "relay/session-host.js"]
    risk: high
    needs:
      - tests-before-after
      - failing-before: { when: [fix, feature] }
      - mutation: { min: 0.85 }
      - probe: { name: restart-run, run: "npm run restart-check", artifacts: [".exhibit/restart.log"] }
    merge_without_reading: never
    source: [D-004, D-011]
  manual:
    match: ["docs/manual/**"]
    risk: low
    needs:
      - probe: { name: link-check, run: "npm run check-links" }
    merge_without_reading: allowed
default:
  risk: medium
  needs:
    - tests-before-after
    - mutation: { min: 0.70 }
```

Rules:

- A PR can match more than one kind. Its requirements are the union of the matched kinds. Its risk is the highest risk among them.
- A PR that matches no kind uses `default`.
- `merge_without_reading: allowed` holds only if every matched kind allows it.
- `source` lists the defect IDs a rule came from. The backtest uses it to find leaks (section 9.9).
- `exhibit check` reads the policy from the base commit, the commit that `--base` names or, with `--pr`, the PR's base commit. It never reads the file on disk. So an edit to `evidence.yml` that is not committed changes nothing, and a PR that changes `evidence.yml` is checked by the policy it had before the change. That PR still gets a `policy-change` gap and `needs_person` (sections 9.8 and 15). When the base commit has no policy file, the defaults hold, as for an empty file. A bad policy in the base commit gives exit 2, and the message says that the policy came from the base commit, so the person fixes it on the base branch.
- Exhibit checks the file against the JSON schema `schema/evidence.schema.json` and refuses to run on an invalid policy. Every command reads the policy the same way. The schema's rules:
  - The top-level keys are `version`, `settings`, `kinds` and `default`. Each one is optional, so an empty file is a valid policy. A key with nothing under it, such as `kinds:`, is the same as no key. Any other key is an error.
  - `version` must be 3, the only format this Exhibit reads.
  - `settings` may hold only `test_command` (text), `test_results` (text), `fix_signals` (a list of signals, section 9.1), `source_paths` (a list of globs on file paths that mark source code, section 9.1), `jira` (the Jira site for the `tracker:jira` signal, section 9.1), `mutation_budget_seconds` (a whole number, 1 or more), `mutation_setup` (text) and `mutation_test_files` (a list of one or more globs), which section 9.5 explains, `probe_timeout_seconds` (a whole number from 1 to 86400, one day, section 9.6), `storage` (`data-branch` or `local`), `data_branch` (a branch name that does not start with `-`) and `local_path` (text). The last three say where `exhibit publish` stores an exhibit (section 9.12).
  - Each key under `kinds` names a kind. A kind must have `match` (a list of one or more globs), `risk` and `needs`. It may have `merge_without_reading` and `source` (a list of defect IDs). It may have no other field.
  - `jira` must have `site`: the Jira site's address, starting with `https://` or `http://`, such as `https://acme.atlassian.net`. It may have `issue_types` (a list of one or more issue type names that count as a bug, `[Bug]` when left out; a list replaces the default), `found_field` (the Jira field that says where a bug was found, such as `customfield_10042`) and `escaped_values` (a list of the values of that field that mean the bug got out to users, such as `[Production]`). `found_field` and `escaped_values` go together: one without the other is an error. It may have no other field. The token is never in this file: it comes from the env (section 9.1). `tracker:jira` in `fix_signals` with no `jira` is an error.
  - `default` must have `risk` and `needs`. It may have `merge_without_reading` and `source`, and no other field.
  - `risk` must be `low`, `medium` or `high`. `merge_without_reading` must be `never` or `allowed`.
  - `needs` is a list of evidence items, and it may be empty. An item is a bare name (`tests-before-after` or `failing-before`), or a mapping with one key: the item type, with its fields. `- failing-before:` with nothing after the colon is the same as the bare name.
  - `failing-before` may have `when`: a list of `fix` and `feature`.
  - `mutation` must have `min`, a number from 0 to 1. NaN (`.nan`) and infinity (`.inf`) are not numbers here.
  - `probe` must have `name` and `run`. It may have `artifacts` (a list of paths) and `author: hidden`.
  - An item type that is not one of the four is an error.
- An invalid policy makes the command exit 2. The message names each bad field and says what is wrong, one field on each line, for example `evidence.yml kinds.relay-core.risk must be low, medium or high, not "extreme".` A file that is not valid YAML gives exit 2 too. A bad `fix_signals` is the one exception: Exhibit checks it first, and its message shows only that problem, as it did before the whole file was checked.

Evidence item types in version 1:

| Type | Met when |
|---|---|
| `tests-before-after` | The test command ran on the base and on the head, and every test passes on the head, except tests marked flaky (section 9.3). |
| `failing-before` | At least one test that the PR added or changed fails on the base and passes on the head (section 9.4). `when` limits it to PRs classified as fix or feature. For any other PR it is `skipped` with the reason, and this skip does not stop `meets_policy` (section 9.8). |
| `mutation` | The catch rate on the changed lines is at least `min`. |
| `probe` | A named command exits 0 on the head and writes its declared artifacts. Screenshots, restart runs, link checks, contract tests and hidden suites are all probes. |

A probe can set `author: hidden`. Exhibit then counts it as a check the builder cannot see.

### 8.2 `evidence.json`

`exhibit check` writes the exhibit to `.exhibit/evidence.json`. The schema is `schema/exhibit.schema.json`, and `exhibit check` checks the exhibit against it before it writes the file.

```json
{
  "exhibit_version": "0.1.0",
  "policy": { "path": "evidence.yml", "sha256": "..." },
  "repo": "owner/name",
  "pr": 112,
  "base": "sha",
  "head": "sha",
  "classification": {
    "kinds": ["relay-core"], "risk": "high", "fix": true, "fix_signal": "label:bug", "feature": false,
    "signals_from": "pr", "merge_without_reading": "never", "used_default": false, "policy_changed": false
  },
  "requirements": [
    {
      "type": "mutation",
      "params": { "min": 0.85 },
      "kinds": ["relay-core"],
      "status": "met",
      "details": { "killed": 23, "survived": 2, "timeout": 1, "no_coverage": 0, "catch_rate": 0.92, "interval_95": [0.75, 0.98] },
      "author": "builder",
      "duration_ms": 184000
    }
  ],
  "verdict": "needs_person",
  "gaps": [ { "type": "probe", "name": "restart-run", "status": "missing", "how_to_fix": "Run npm run restart-check and attach .exhibit/restart.log." } ],
  "checks_by_author": { "builder": 3, "hidden": 2 },
  "flaky_tests": [],
  "environment": { "node": "20.x", "os": "linux" },
  "created_at": "2026-11-18T18:00:00Z"
}
```

The fields:

- `policy`: the policy file and the SHA-256 of its bytes in the base commit (section 8.1). `path` is the policy file, which is `evidence.yml` unless `--policy` names another file. `sha256` is null when the base commit has no such file.
- `repo` is `owner/name` from `--repo`, or null. `pr` is the number from `--pr`, or null.
- `base` and `head` are full commit SHAs. The changed files are the files that differ between the merge base of the two and `head`. A renamed file counts under its old path and its new path.
- `classification` (section 9.1): `kinds` holds the matched kinds, sorted by name. `fix_signal` is the first fix signal that matched, or null. `signals_from` is `pr` when the forge gave the title, body, labels and branch, or `branch` when only the local branch name was known. `used_default` is true when no kind matched. `policy_changed` is true when the change touches the policy file, which is `evidence.yml` unless `--policy` names another file.
- `requirements`: one for each evidence item the change needs, in order: the matched kinds by name, then each kind's own order. A need that two kinds share is one requirement, and its `kinds` names both. `params` holds the item's fields, without `author`. `author` is `hidden` for a probe with `author: hidden`, and `builder` for every other item.
- `gaps`: one for each requirement that is not `met`, plus a gap of type `policy-change` when the change touches the policy file, and a gap of type `no-rule` when no kind matched and the policy has no `default`. Each gap says how to fix it in plain words.
- `duration_ms` and `created_at` are the timing fields. Two runs on the same base and head, with the same policy, give the same file apart from them.

`status` is one of `met`, `missing`, `failed`, `skipped` or `error`. An `error` on any requirement makes the verdict `error`, never `meets_policy`. A `skipped` requirement is not met, so it makes the verdict `needs_person` (section 9.8).

The `tests-before-after` collector is built (section 9.3), the `failing-before` collector is built (section 9.4), a `probe` requirement runs its command (section 9.6), and a `mutation` requirement runs Stryker on the changed lines (section 9.5). In the example, `killed` does not hold the timeouts, and `survived` does not hold the mutants that no test reached: the catch rate counts both, so it is 24 of 26. A `mutation` requirement is `skipped` when the change has code in a language that no mutation adapter covers yet, such as Python.

A `failing-before` whose `when` does not fit the change is `skipped` too, but it is not a gap. Its `details.reason` says that the policy asks for it only on a fix or a feature, and that this change is neither. It does not stop `meets_policy`, and it does not count in `checks_by_author`.

`flaky_tests` lists each test that failed and then passed on its second run, on the base or the head (section 9.3). A test's name is its file, relative to the repo, its classname and its name, joined by ` > `, for example `test/math.test.js > test > add sums two numbers`. A part that the JUnit file leaves out is left out of the name too. Node 20's reporter gives no file, for example.

### 8.3 `.exhibit/history.jsonl`

One merged PR per line, with these fields:

- `number`, `title`, `body`, `author`, `labels`, `merged_at`, `base_ref`, `base_sha`, `head_sha`, `merge_sha`
- `forge`: the forge the PR came from, and `url`: the PR's web page on that forge
- `files`: path, additions and deletions for each file
- `classification`: `fix` is true when the PR is a fix, and `fix_signal` names the signal that matched. `fix_signal` is null when no signal matched. When `tracker:jira` matched, `fix_signal` names the Jira issue, such as `jira:PAY-482`, not the signal. `escaped` is there only on such a fix, when `settings.jira.found_field` is set and the issue has a value in it: `false` means the bug was found before release, so it is not an escaped defect (section 8.5), and `true` means it got out to users. `kinds` holds the kinds in `evidence.yml` whose globs match a path in the line's `files`, sorted by name (see "Kinds of change" below).
- `reviews`: `list` holds the `state`, `author` and `source` of each review, oldest first. `source` is `review` for a GitHub review, or `comment` for a review posted as a PR comment. `change_request_rounds` is the number of reviews with the state `CHANGES_REQUESTED`, from both sources.
- `ci`: the `name` and `conclusion` of each check run on the PR's last head commit, then of each commit status on it. For a commit status, `name` is its context and `conclusion` is its state. A reader of `ci`, such as the S5 backtest, must allow for two things: an app that posts both a check run and a commit status with the same name shows up twice, and a commit status can give the conclusion `error`, which a check run never gives.
- `evidence_section`: the evidence the PR body claims, if the repo uses such a section
- `szz`: for fix PRs, the introducing PRs, the lines, the blame output for each line, and a confidence score
- `exhibit`: the verdict and the requirements, if an exhibit exists for this PR

The schema for one line is `schema/history-line.schema.json`. `exhibit history` checks every line against it before it writes the file. If a line fails, it writes nothing and exits 2.

What each version fills:

- **S1, first half:** `number`, `title`, `body`, `author`, `labels`, `merged_at`, `base_ref`, `base_sha`, `merge_sha` and `files`. `body` is null when the PR has no description. `author` is null when the account was deleted. Lines are in merge order, newest first. GitHub lists at most 3,000 files for one PR, so `files` for a larger PR is cut short. When that happens, `exhibit history` prints a warning on stderr that names the PR and both counts, and still exits 0. GitHub gives each PR's count of changed files in the same GraphQL query as the PR (section 11), so the count costs no request. So `exhibit history` compares the count with the list for every PR it reads, not only for a list of 3,000 files. If GitHub's files list stops at another number, such as 2,500 for a PR that changed 2,600 files, the warning still fires. That count is only for the warning. So when a forge cannot give it, `exhibit history` does not fail. For a list of 3,000 files, it warns that the PR's `files` may be cut short and that the count is unknown, and goes on. A shorter list gets no warning, because it is most likely complete. `number` is the PR number that people see on the forge. `base_ref` is the branch the PR was merged into. `base_sha` is the tip of the base branch when the PR was last updated. It is not always the merge-base of the PR. `merge_sha` is the commit the merge put on the base branch: a merge commit, a squash commit, or the last copy of a "rebase and merge". The schema requires `base_ref`. A history file from before ticket 32 has no `base_ref`, so it fails the schema. Run `exhibit history` again: it writes the whole file new, so the new file has `base_ref` on every line.
- **S1, second half:** `reviews` and `ci`. The schema requires both. A PR with no reviews has `{"change_request_rounds": 0, "list": []}`. A change request that was later dismissed has the state `DISMISSED`, so it is not a round. A review `author` is null when the account was deleted. A PR with no check runs and no commit statuses has an empty `ci` list. A check run that has not finished has a null `conclusion`. Some CI services post commit statuses instead of check runs, so `ci` holds both: check runs first, then commit statuses. For commit statuses, GitHub gives only the newest status for each context. The commit statuses are oldest first, as the REST combined status lists them (section 11). A status `conclusion` is `success`, `failure` or `error`, and a `pending` status has a null `conclusion`, the same as a check run that has not finished.
- **Reviews posted as PR comments:** some rooms post each review as a PR comment, not as a GitHub review. On Building58 no merged PR has a GitHub review. So `exhibit history` also reads the PR's comments, and a comment that gives a verdict is a review with the `source` `comment`:
  - A verdict is the word `verdict`, then `merge` or `fix`, as in `Verdict: fix` or `**Verdict:** merge`. A colon, spaces, `*`, `_`, backticks and equals signs may come between them, as in ``Verdict: `merge` `` or `Verdict = fix`. A hyphen may come between them too, as in `Verdict - fix`, but only when the phrase starts the line, after any spaces, `>`, `#`, `*` or `_`, and after a list marker such as `-`, `+`, `*`, `1.` or `1)`. So `- Verdict - fix` and `1. Verdict - merge` count. In prose a hyphen is often a dash, so `The verdict - merge - waits on CI.` is not a verdict, and neither is `## Code review of b8ebe79 - merge`, where other words come before the phrase. A review heading with the verdict after the commit is a verdict too, as in `## Review of b8ebe79: merge`. Case does not matter.
  - A line that starts with `>`, after any spaces, is a markdown quote of another comment, so its verdict does not count. A reply that quotes `> Verdict: fix` and then says `Fixed in abc1234` is not a review. A line right after a quote line is in the quote too, as markdown shows it, until a blank line, a heading, a code fence, a list item or a thematic break ends the quote. A thematic break is three or more of the same mark, `-`, `*` or `_`, as in `---`, so `-*-` stays in the quote. A backtick code fence has no backtick after its marks, so a line such as ```` ```x``` said ```` is text with inline code. Only plain text goes on a quote this way. And it goes on only when the quote's last line is text: after a blank quote line (`>`), a heading, a code fence, a line of code, a thematic break or an empty list item (such as `> -`) in the quote, the next line is not in the quote. A heading may be a line of `=` or `-` right under a line of text, with the same count of `>` as the quote that holds the paragraph, as in `> quoted` then `> ===`. With fewer `>`, as in `> > quoted` then `> ===`, that line is lazy text in the nested quote, but an empty list item such as `> -` still ends it. A lazy line does not change that count, so in `> > quoted`, `> more`, `> ===`, all three lines are one paragraph of the nested quote. A line of code is a line in a code fence in the quote, or a line indented by four spaces (not a tab) after the `>` that does not come right after a line of text. Two kinds of line are not quotes:
    - A line in a code fence (```` ``` ```` or `~~~`), even when it starts with `>`.
    - A line of a GitHub alert box, such as `> [!IMPORTANT]` then `> Verdict: fix`. An alert box is the comment's own text, so its verdict counts. A quote nested in an alert box, as in `> > Verdict: fix`, is still a quote. A line right after a line of text in the nested quote, as in `> Verdict: fix`, is in the nested quote too, as GitHub shows it, until a blank line, a heading, a code fence, a list item or a thematic break in the alert box ends it. The alert kinds are `NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`.
  - When a comment gives a verdict only in quoted lines, `exhibit history` does not count it, and prints a warning on stderr that names the PR, the comment's author and time, and the verdict. Most such comments are replies, but the warning lets a person find a review that quoted its own verdict.
  - The first verdict in the comment counts. `fix` gives the state `CHANGES_REQUESTED`, so it is a round. `merge` gives the state `APPROVED`.
  - A comment that starts with an `<!-- office:` marker, such as `<!-- office:dev -->`, is a room note or a Dev's reply, not a review, even when it repeats the verdict.
  - A comment with no verdict is not a review, and is not in `reviews`.
  - The comment reviews and the GitHub reviews are merged into one list by time: the forge gives each comment and each review an `at`. At the same time, the review comes first. A pending review has no `at`, so it comes before every comment that is still left, even an older one.
- **Head commit, forge and web page (ticket 78):** every line has `head_sha`, `forge` and `url`, and the schema requires all three.
  - `head_sha` is the PR's last head commit: the last commit on the PR's branch. It is not the merge commit. For a squash merge, `merge_sha` is a new commit that is not on the PR's branch at all. With `head_sha`, `git merge-base` can find where the PR's branch left the base branch from the line alone, for example `git merge-base <head_sha> <merge_sha>^1`. This needs the head commit in the clone. GitHub keeps it at `refs/pull/<number>/head` after the branch is deleted, but a plain clone does not fetch those refs, so fetch them first, for example with `git fetch origin '+refs/pull/*/head:refs/pull/*/head'`.
  - `forge` names the forge the PR came from. Today it is always `github`. The schema allows only the forges Exhibit knows, so a new forge adds its name there.
  - `url` is the PR's web page on the forge, such as `https://github.com/bfalkowski/Building58/pull/82`.
  - A history file from before ticket 78 has no `head_sha`, `forge` or `url`, so it fails the schema. Run `exhibit history` again: it writes the whole file new, so the new file has the three fields on every line.
- **S2, fix signals:** `classification` holds two fields. `fix` is true when any fix signal matches (section 9.1). `fix_signal` is the first signal in the list that matched, such as `label:bug`, so a person can see why the PR counts as a fix. It is null when no signal matched. Every line has `classification`. A history file from before S2 has no `classification`, so it fails the schema. Run `exhibit history` again: it writes the whole file new, so the new file has `classification` on every line.
- **S2, SZZ:** every line has `szz` (section 9.2), and the schema requires it. A history file written before `szz` was added has no `szz`, so it fails the schema, even when it has `classification`. Run `exhibit history` again: it writes the whole file new, so the new file has `szz` on every line. `szz` is null when the PR is not a fix, or when SZZ did not run. Otherwise it holds five fields:
  - `blamed_commit`: the commit that `git blame` ran on: the parent of the fix's first commit on the main branch (section 9.2, step 3). It is null for a revert, because SZZ runs no blame on it.
  - `links`: one for each introducing PR, highest confidence first. A link has `pr`, `confidence` and `lines`. A link that SZZ found from a revert, with no blame, also has `found_by` with the value `revert`, and its `lines` is empty (section 9.2, "Reverts"). A link found by blame has no `found_by`.
  - `unlinked_lines`: the lines whose commit is in no merged PR, such as a commit pushed straight to the main branch.
  - `dropped_lines`: the lines that SZZ does not count, because they carry no bug (section 9.2, steps 2 and 5). Each has `path`, `line`, `text` and `reason`. The `reason` is `whitespace`, `comment`, `moved` or `newer than the bug report`.
  - `no_link_reason`: why the fix has no links, when SZZ dropped every line it deleted or changed. It names the reasons, in the order whitespace, comments, moved lines, lines newer than the bug report, and ends with "only": for example "whitespace only", "moved lines only" or "whitespace and comments only". It is null when some lines are left, or when the fix deleted or changed no lines. For a revert that has no link, it is "reverted change not found" when SZZ found no PR in this repo that the revert names: the body names none (a title-only revert), names only PRs in other repos, or names work that neither the history nor the forge knows. It is "reverts a revert" when every PR it found is itself a revert (section 9.2, "Reverts").

  Each line in `links` and `unlinked_lines` has `path`, `line` (its number in `blamed_commit`), `text`, and `blame`. `blame` holds what `git blame` says about the line: `commit`, `original_path`, `original_line`, `author`, `author_time` (UTC) and `summary` (the first line of the commit message).

  A history file from before ticket 8 has no `dropped_lines` or `no_link_reason`, so it fails the schema. Run `exhibit history` again: it writes the whole file new.

  A history file from before revert links (ticket 196) has no `found_by` on any link and a `blamed_commit` on every `szz`. It still passes the schema and reads as before, because `found_by` is optional. On an incremental run, a kept fix whose `szz` came from blame gets SZZ again when the `revert` signal now marks it, and a kept revert gets SZZ again when another signal now marks it.
- **Reading the list of merged PRs (ticket 103):** a big repo has many thousands of merged PRs, and reading them all can take many minutes and most of the hourly rate limit. So `--since` and `--limit` also stop the list early:
  - With neither option, `exhibit history` reads the whole list, in the order GitHub gives it.
  - With `--since`, `--limit` or both, it asks for the list ordered by the time each PR was last updated, newest first. A merge updates a PR, so a PR was last updated at or after its merge. So when a page ends with a PR updated before `--since`, every later PR was merged before `--since` too, and the run stops.
  - `--limit N` stops the same way. When N PRs that the run keeps were merged after the last update time on the page, every later PR was merged before them, so it is not among the newest N, and the run stops. For example, with `--limit 2`, page 1 holds PR 16 (merged Nov 20 at noon) and PR 15 (merged and last updated Nov 19 at noon). With the one-day margin of the next point, a later PR may be merged as late as Nov 20 at noon, so the run reads page 2. Page 2 ends with a PR last updated Nov 16 at noon. PRs 16 and 15 were merged after Nov 17 at noon, so the run stops there.
  - GitHub's order does not always follow the `updatedAt` it gives. On cli/cli, in a list of 100 merged PRs, PR 14815 came after PR 15028, although PR 14815 was last updated 2.2 hours later. GitHub does not say what the order sorts on. So each stop allows a later PR to be updated, and merged, up to one day after the last update time on the page. With `--since`, the run stops when a page ends with a PR updated more than one day before `--since`. With `--limit N`, it counts the PRs merged more than one day after that time. The margin is `ORDER_MARGIN_MS` in src/github.js. It is a guess, made large against the one case seen. A PR that GitHub lists more than one day lower than its merge can still be missed.
  - A merged PR is still updated by a later comment, label or edit. Such a PR comes early in the list, so the run reads more pages than the PRs it keeps. The stop is still safe: it never leaves out a PR that the options keep.
  - When someone updates a PR while the run reads the list, that PR moves to the top, and the later pages no longer hold it. So after a run that read more than one page, it reads the list again from the top, down to a page that ends with a PR updated more than one day before the newest update on its first page. This is most often one or two more queries. A PR that is updated during this last read can still be missed. The next run finds it.
  - A run with no options reads the whole list. Incremental runs (next point) need the whole list too, unless they have `--since` or `--limit`.
- **Incremental runs (ticket 94):** a merged PR almost never changes, so a run that finds `.exhibit/history.jsonl` from an earlier run reads only what is new:
  - It reads GitHub's list of merged PRs as a first run does: the whole list, or, with `--since` or `--limit`, only the top of it (see "Reading the list of merged PRs" above). That costs one GraphQL query for each 50 merged PRs it reads, and the query also reads each PR's lists (section 11). `--since` and `--limit` pick from this list as they do on a first run, so the new file holds the same PRs that a first run with the same options would write. A line for a PR they leave out is dropped.
  - A PR that has no line in the old file is read in full: its files, reviews, comments and CI results. So a PR merged after the last run gets a new line. So does an older PR that an earlier `--since` or `--limit` left out.
  - The look-back window is the 7 days before the newest `merged_at` in the old file. A PR merged in that window, at its start time or later, is read again, and its new line replaces the old one. So a late review, a late review comment, or a CI result that finished after the last run shows up. A late review on a PR merged before the window does not show up: run with `--full` for that.
  - Every other line is kept, and no request asks about its PR. Only its `title`, `body`, `labels` and `classification` can change (see the next point).
  - Every run classifies every line again with the `fix_signals` in `evidence.yml` (section 9.1), kept lines too. The list of merged PRs holds each PR's `title`, `body`, `labels` and head branch as they are now on GitHub. A kept line takes the `title`, `body` and `labels` from that list, so the line's fields agree with its classification, and is classified from them and from the head branch, because a line does not hold its branch name. The run reads that list anyway, so this costs no request. So after you change `fix_signals`, the next run gives the whole file the new classification, and no line keeps an old one. The run does not need to know which signals made the old file. A label added on GitHub reaches a kept line the same way: when a person adds the label `bug` to an old PR to mark an escaped defect, the next plain run makes its line a fix, with no `--full`. When a line's `classification` differs from the old file, the run prints one note on stderr that names each such PR, for example "exhibit: note: 2 PRs in .exhibit/history.jsonl are classified another way than in the old file: PR 96 is now a fix (pr:96), PR 12 is no longer a fix." The note does not say why, because the cause can be a change to `fix_signals` or a change on GitHub, such as a new label. Up to 10 PRs are named, and the note gives the count of the rest.
  - A line that stops being a fix gets `szz` null, as every PR that is not a fix has. A kept line that becomes a fix has `szz` null in the old file, so SZZ runs on it, inside a clone (next point). SZZ can ask GitHub which PR holds a blamed commit, so these new fixes can cost requests.
  - SZZ runs on a fix PR that was read, unless the old file already had it as a fix with a `szz` that is not null: then it keeps that `szz`, because the PR's code does not change after its merge. A fix whose `szz` was null, because SZZ skipped it, gets SZZ again. A revert is the one case where the code is not enough: its links come from its `body` (section 9.2, "Reverts"), and a line, kept or read, takes the body that GitHub holds now. So when a revert's `body` differs from the old file, SZZ runs on it again, and the links follow the new body. The map from a commit to its PR still sees every line in the file, kept lines too.
  - The file stays in merge order, newest first.
  - `--full` reads every PR again and writes the whole file new. You do not need it after you change `fix_signals` or the kinds: a plain run classifies every line again.
  - A run reads every PR again by itself, and prints one note on stderr that says why, when the old file has a line that is not JSON, a line that does not fit the schema (as in a file from an older version of Exhibit), or a line from another repo or forge.
  - Every run prints how many PRs it read from GitHub, how many GitHub REST requests it made, and how many GraphQL queries it made and how many points they used (section 8.6). With `--json`, the summary has `read`, and `mode`: `full` for a run that read every PR, or `incremental`.
  - The query for the list of merged PRs also reads the first page of each PR's labels, files, reviews, comments and CI results, for every merged PR, also the ones the run keeps. So an incremental run sends the same queries for the list as a full run. It sends fewer queries only for PRs with lists longer than one page. An incremental run still saves the SZZ requests of the kept lines.
- **Kinds of change (S4):** `exhibit history` gives each line's `files` to the same function that gives `exhibit check` its kinds (`matchKinds` in `src/classify.js`), so a PR gets the same `kinds` from both. An empty list means no kind matched, so `default` applies.
  - With no `evidence.yml`, or one with no kinds, `kinds` is an empty list on every line, and the run says so in one line on stderr.
  - A run matches every line again under the current kinds, kept lines too, as it does for `fix_signals`. A kept line is matched from its own `files`, so this costs no request, and no line keeps the kinds of an older policy. When the kinds change, the run prints one note on stderr that names each PR whose kinds changed, with the old and the new kinds, such as `PR 1 from default to config`. It names at most 10 PRs, then says how many more there are.
  - The schema allows `kinds` in `classification`, as a list of any names the policy schema takes for a kind, and refuses any other field there but `fix`, `fix_signal` and `escaped`. `exhibit history` always writes `kinds`. A file written before S4 has no `kinds`, and still passes the schema, so the next run keeps its lines and fills `kinds` in, with no note.
- **Later slices:** `evidence_section` and `exhibit` are filled by later slices. Until then they are absent, and the schema allows them only as null.

When GitHub says to wait, `exhibit history` waits and asks again, at most three times. GitHub says to wait with a 429 or 403 reply, or, for a GraphQL query, with a 200 reply that holds an error of the type `RATE_LIMITED`, in one of three ways:

- A `retry-after` header. It holds whole seconds, or an HTTP date such as `Thu, 19 Nov 2026 10:00:30 GMT`, and `exhibit history` waits that long or until that time. A value in any other form, such as `1.5`, counts as no `retry-after` header.
- No requests left until `x-ratelimit-reset`. `exhibit history` waits until one second after that time.
- A message that names a secondary rate limit, with neither of these headers. GitHub's docs say to wait at least one minute, and longer each time the limit comes back. So the first wait for a secondary limit is one minute, the second two minutes, and the third four minutes. Waits from a `retry-after` header or from `x-ratelimit-reset` do not count toward this. Each wait gets a random extra of up to a quarter of it, so the requests that hit the limit together do not all ask again at the same moment. The longest such wait is five minutes.

If GitHub asks for a wait longer than 15 minutes, it stops and exits 2. After three waits it stops and exits 2 too.

`exhibit history` reads `GITHUB_TOKEN`. A fine-grained token needs these repository permissions:

- Metadata: read. GitHub gives it to every fine-grained token.
- Pull requests: read, for the PRs, their files, reviews and comments, and for the PRs of a commit (SZZ).
- Checks: read, for the check runs. GitHub's page of permissions for fine-grained tokens does not list the check-runs request, so this one is not yet confirmed.
- Commit statuses: read, for the commit statuses.

A classic token needs the `repo` scope for a private repo, and no scope for a public one. When a request gets a 403 that is not a rate limit, the message names the permission that request needs, so a person can see which one the token lacks. A 429, and a rate limit that is still there when the waits end, say that GitHub's rate limit is used up. They do not name a permission or tell you to check the token.

### 8.4 `.exhibit/labels.jsonl`

`exhibit label` writes this file. It reads the escaped defects from `.exhibit/history.jsonl`: the fix PRs that SZZ linked to at least one introducing PR, newest fix first. This is the same list that the report shows (section 8.5), and the same code makes both.

One labeled escaped defect per line, with these fields:

- `id`: `D-` and the fix PR's number, with zeros in front to make at least three digits. PR 4 gives `D-004`, PR 58 gives `D-058`, and PR 1234 gives `D-1234`. A PR's number never changes, so the `id` stays the same when `exhibit history` runs again, with `--full` too. Policy rules cite these IDs in `source` (section 8.1).
- `fix_pr`: the fix PR's number. `introducing_prs`: the numbers of the PRs that SZZ linked to the fix and the person kept, highest confidence first. It is empty when the person rejected every link.
- `rejected_prs`: the numbers of the PRs that SZZ linked to the fix and the person rejected, highest confidence first. It is empty when the person kept every link. Lines written before a person could reject a link have no `rejected_prs`, and read as if it were empty.
- `code`: a short description of what went wrong. One line of at most 200 characters.
- `category`: one line of at most 60 characters.
- `would_have_caught`: the evidence that would have caught it. One line of at most 500 characters.
- `labeled_by`: `person`, or `claude_draft_confirmed`, or `claude_draft_edited`. It is `person` when the person typed the label: with no draft, or after throwing the draft away with `t`. After `t` it stays `person` even when the person types the draft's code and category again, because they did not accept the draft. Otherwise it is `claude_draft_confirmed` when the label has the code and the category of Claude's draft, and `claude_draft_edited` when the person changed either one.
- `claude_draft`: the draft that `exhibit label --claude` showed, with its `code`, its `category`, and the `model` that wrote it. It is kept with all three values of `labeled_by`, so a change from the draft can be seen later. It is absent when no draft was shown: without `--claude`, or when the draft failed.
- `szz_link_rejected`: true when the person rejected at least one link of the defect, and false when they kept every link. A defect can have more than one link, so `rejected_prs` says which links. `exhibit label` checks that `szz_link_rejected` is true exactly when `rejected_prs` is not empty.
- `labeled_at`: the time of the label, in UTC.

The schema for one line is `schema/labels-line.schema.json`. `exhibit label` also checks that `id` matches `fix_pr`, that `szz_link_rejected` matches `rejected_prs`, that a `claude_draft_confirmed` or `claude_draft_edited` line has `claude_draft`, and that a `claude_draft_confirmed` line has the draft's code and category.

How `exhibit label` works:

- It shows each defect that has no line in the file yet, one at a time: the fix PR, its title and web page, the commit that SZZ blamed, and each introducing PR with its confidence. Under each introducing PR are its lines and what `git blame` said about each one, as in the report, at most 5 lines for each link.
- SZZ makes false links, for example from refactors and moved code (section 15). So for each link of the defect, it first asks the person to keep it (`k`) or reject it (`r`), with the link's PR and confidence. For a link found from a revert, the question also says "evidence: revert", and the defect shows the revert in place of blame lines. A revert is not always a bug, for example a rollback for a launch date, so the person can reject that link too. Any other answer is asked again. A rejected link goes to `rejected_prs` and not to `introducing_prs`. When the person rejects every link, the defect is still a real bug, with no known introducing PR: the person can still give it a code, or skip it. The rejections are not fed back into SZZ or the report. The backtest (section 9.9) reads them.
- With `--claude`, Claude drafts a code and a category for the defect before it is shown (section 9.11). After the link questions, the draft is shown under "Claude's draft, not saved yet". The person types `c` to confirm it, `e` to edit it, or `t` to throw it away and type their own, or `s` to skip the defect. Any other answer is asked again. When editing, an empty answer keeps the draft's code or category. When the draft failed, a plain message says why, and the person labels that defect by hand. Then it asks for the evidence that would have caught it. Claude never drafts that.
- Without a draft, it asks three questions: the code, the category, and the evidence that would have caught it. For the category, it lists the categories used so far, from the file and from this run. The person types a number from the list, or a new category. An empty answer is asked again.
- An answer of only digits at the category question picks from the list. A number that is not in the list, such as 99 or 0, is asked again, and the message gives the numbers in the list. So a new category cannot be only digits: "2" always means the second category in the list.
- It checks the length of each code, category and evidence as the person gives it. An answer longer than the field's limit above (200, 60 or 500 characters) is asked again at once, and the message says the limit. The answers already given stay, so the person types only that one again. The limits come from the patterns in the schema.
- It checks the label against the schema, then adds it to the end of the file at once. So quitting halfway keeps the labels given so far. A label that fails the schema is not written: `exhibit label` exits 2 and names the problem, and the file keeps its earlier lines.
- `s` at a link question, at the draft question or at the code question skips a defect. `q` at any question, or the end of the input, quits. The defect it was on is not written, even with a draft on screen. The next run shows the skipped defects and the defects it did not reach, and no defect that has a line.
- At the end it says how many defects it labeled and skipped, and how many still have no code. With `--json`, it shows the defects and the questions on stderr, and prints one summary line on stdout: `{ "shown": 3, "labeled": 2, "skipped": 1, "open": 1, "output": ".exhibit/labels.jsonl" }`. `shown` counts the defects it showed, and `open` counts the defects still with no line in the file.
- With `--claude`, the end of the run also says how often the person kept Claude's draft unchanged, once for this run and once for the whole file (section 9.11). With `--json`, the summary line has the same numbers in `drafts`, with `run` and `file`. Each holds `shown`, `kept`, `edited`, `replaced` and `kept_share`, which is null when there are no drafts, and otherwise holds `kept`, `n`, `rate`, `low`, `high` and `weak`.
- It exits 2 with a message that says to run `exhibit history` first when there is no `.exhibit/history.jsonl`, or when the history has no SZZ links. It exits 2 too when a history line fails the history schema, or a labels line is not JSON or fails the labels schema. It then names the line, and writes nothing.
- A line for a defect that is no longer in the history, for example after a run of `exhibit history` with a smaller `--limit`, stays in the file.
- `exhibit history` never changes this file. So when it runs again and SZZ links the fix to the same PRs, a rejected link stays rejected: the line keeps its `rejected_prs`, and `exhibit label` does not ask about the defect again.

### 8.5 Report

`exhibit history` and `exhibit backtest` each write a report as a markdown file and a self-contained HTML file. The first screen of the history report shows:
- The number of PRs read and the number of fix PRs.
- The escaped defects found, each with its SZZ evidence.
- How sure Exhibit is, in plain words. With weak history, the report says so instead of guessing.

`exhibit history` writes the report to `.exhibit/report.md` and `.exhibit/report.html`, together with `.exhibit/history.jsonl`. It writes all three to temporary files first, and renames them only when every write worked. After a run that worked, both report files come from the same content, so they hold the same facts. A run that fails on a write, for example on a full disk, changes none of the three files, and they keep the same facts. The run renames the files in this order: `.exhibit/history.jsonl`, `.exhibit/report.md`, `.exhibit/report.html`. In a rare case, a rename fails after an earlier rename worked. Then the run changes `.exhibit/history.jsonl`, and maybe `.exhibit/report.md`, but not every file, so the files can hold different facts. The next run writes both reports again from the new `.exhibit/history.jsonl`. `--json` names the two files in its `report` field.

`exhibit backtest` writes its own report, to `.exhibit/backtest.md` and `.exhibit/backtest.html`. It never writes to `.exhibit/report.md` or `.exhibit/report.html`, so a backtest run does not change the history report. Backtest writes all its files together in the same way as history: to temporary files first, renamed only when every write worked (`writeTogether` in src/write-together.js). So a backtest run that fails on a write changes none of its files. As for history, a rename that fails after an earlier rename worked can change some of its files but not all. Section 9.9 says what the backtest report holds.

The first screen of the backtest report shows the funnel (section 9.9): how many defects are left at each step, and why the others were lost.

1. Fix PRs found.
2. Fix PRs with an SZZ link.
3. Defects with a link that a person kept.
4. Defects named in a rule's `source`.
5. Defects that the policy would have flagged.

The history report has these parts, in this order:

1. **The counts.** The number of merged PRs read, the number of fix PRs, and how many of the fix PRs SZZ linked to an introducing PR. Each fix PR with at least one link is an escaped defect. When SZZ skipped a fix PR (section 9.2), the count says so. With no fix PRs, the report says so in one sentence and has no list of defects. Outside a clone, SZZ did not run, and the report says it cannot show escaped defects.
2. **How sure Exhibit is.** Whether the history is weak, and why, in plain words, then the rule below.
3. **The escaped defects**, newest fix first. For a revert, the report says that SZZ ran no git blame, and each introducing PR shows "evidence: revert" and the revert's number in place of lines. For each one: the fix PR and its title, the commit that SZZ blamed, and each introducing PR with its confidence as a percent and as a count of the fix's counted lines. Under each introducing PR are its lines (path, line number and text) and what `git blame` said about each one: the commit, the author, the date and the commit summary, and the first path and line when they differ. The lines that came from no merged PR are listed too. The report shows at most 5 lines for each link, then says how many more there are. `history.jsonl` has them all.
4. **The fix PRs with no escaped defect found**, and why: a revert that names no PR in this repo that Exhibit found, a revert of a revert, SZZ skipped the PR, dropped every line (the `no_link_reason`), found its lines only in commits that are in no merged PR, or found no deleted or changed line to blame.
5. **The fix PRs whose bug was found before release**: the fixes whose `classification.escaped` is `false` (section 9.1), each with its Jira issue. They are fix PRs, but not escaped defects, even when SZZ linked them, so `exhibit label` does not list them either. This part is there only when there is at least one.

**Weak history.** The history is weak when one of these is true:

- It has fewer than 10 fix PRs. With 9 it is weak, and with 10 it is not.
- SZZ linked none of the fix PRs, or did not run.
- Fewer than half of the escaped defects have a strong link. A strong link has a confidence of 0.5 or more. So 2 strong defects of 4 is not weak, and 1 of 4 is weak.

Each link counts lines, not bugs, so with few fixes, or with links that hold only a small part of a fix's lines, Exhibit cannot tell a real pattern from chance. A weak history makes the report say "The history is weak" and list the reasons. With no fix PRs, the report also says to check that the fix signals match how the repo marks a fix, and names them.

`report.html` works with no network. Its styles are in the file. It has no scripts, no images, no links, and a Content Security Policy of `default-src 'none'; style-src 'unsafe-inline'`, so a browser loads nothing from outside the file. It escapes all text from the history, so a PR title cannot add HTML. `report.md` escapes markdown marks in that text, so a title is shown as it is.

### 8.6 Reply cache

GitHub allows a token 5,000 REST requests an hour, and every run with that token shares the limit. A conditional request costs nothing when nothing changed: GitHub answers `304 Not Modified`, and a 304 does not count against the rate limit. So `exhibit history` saves GitHub replies in a reply cache, and asks again with `If-None-Match`.

- **The folder.** All runs by one user on a machine share one folder: `exhibit/github` in the user's cache folder. That is `$XDG_CACHE_HOME/exhibit/github` when `XDG_CACHE_HOME` is set. Otherwise it is `~/Library/Caches/exhibit/github` on macOS, `%LOCALAPPDATA%\exhibit\github` on Windows, and `~/.cache/exhibit/github` elsewhere. The first read or write of a run makes the folder if it is not there, and sets its mode to 700, because it can hold replies about private repos. So a run where every request gets a 304, and that writes nothing, still narrows an old folder. Each file has mode 600.
- **An entry.** Each entry is one JSON file that holds the URL, the ETag, the body of the reply, and its `content-type` and `link` headers. The client reads the next page from `link`. Only a 200 reply with an ETag is saved. A newer 200 for the same URL replaces the entry.
- **The key.** The file name is a SHA-256 hash of the URL and a SHA-256 hash of the token. So two tokens never share an entry, even for the same URL, and a token with less access never gets a reply that another token read. No file name or file holds the token.
- **A request.** When the URL has an entry, the request sends its ETag in `If-None-Match`. A 304 gives the saved body. Any other reply is used as before, and a 200 with an ETag replaces the entry.
- **A full last page.** GitHub's ETag covers the body only, not the `link` header. When a list's last page is full and a new item comes, the item goes on a new page. The full page does not change, so it gets a 304, and its saved `link` names no next page. So when a page of a list comes from the cache, is full (it has as many items as `per_page`, or 30 when the URL names none), and its saved `link` names no next page, the client also asks for the next page: the same URL with the next page number (`page=2` when the URL names no page). That request uses the cache too. An empty list says there is no new page, and it is saved, so on later runs it gets a 304 until an item comes. So a list whose item count is an exact multiple of `per_page` costs one full request once, not on every run. A list that grew gives its new items from that page. A page that is not full is the last page, so its 304 is trusted.
- **A broken entry.** An entry that is not valid JSON, is cut short, or lacks a field counts as no entry: the request goes without `If-None-Match`, and the new reply replaces it. A write first goes to a temporary file that is then renamed, so another run never reads half an entry. A write that fails is ignored. The cache never stops a run.
- **`--no-cache`.** The run reads no entry, sends no `If-None-Match`, and writes nothing to the folder.
- **GraphQL.** History reads the PRs with GitHub's GraphQL API (section 11). A GraphQL query is a POST request, and GitHub gives it no ETag, so the cache does not hold GraphQL replies. Today only SZZ's REST requests use the cache.
- **The counts.** At the end, `exhibit history` prints how many REST requests went to GitHub and how many got a 304, then how many GraphQL queries went and how many points they used, for example `Made 6 GitHub REST requests. 6 got a 304 and came from the cache in /Users/me/Library/Caches/exhibit/github.` and `Made 3 GitHub GraphQL queries, which used 3 points of the GraphQL rate limit.` With `tracker:jira` in the fix signals and a token, a last line says how many Jira requests the run made, for example `Made 4 Jira requests. 1 named an issue that Jira does not know.` (section 9.1). With `--no-cache` the second sentence is `The cache was off.` `--json` gives the same in its `github` field: `{ "requests": 6, "not_modified": 6, "cache": "<folder>", "graphql": { "queries": 3, "points": 3 } }`, with `cache` null under `--no-cache`. The points are the `cost` that GitHub gives for each query. A request or query that is asked again after a rate-limit wait, or a request for the page after a full last page from the cache, counts each time. A request that never reached GitHub, such as one with no network, does not count. A run that fails prints the counts on stderr before it exits 2.
- **Old entries.** Without a limit, the folder grows by one file for each URL and token. So a run removes the entries that no run has used for 30 days. A run uses an entry when it reads it or writes it: a read that finds an entry sets the file's time to now, and a write makes a new file. At the end of each run that uses the cache, also a run that fails, `exhibit history` removes each entry file and each temporary file in the folder whose time is 30 days old or more. It leaves files whose names the cache did not make. A removed entry costs one full request the next time, and the reply is saved again. A file that another run removes first is skipped, and a removal that fails is ignored. `--no-cache` removes nothing.

Deleting the folder is always safe: the next run fills it again.

## 9. How the parts work

### 9.1 Classifying a change

- Kinds are matched by globs on the changed file paths.
- A PR counts as a fix when any signal in `fix_signals` matches. A signal is a type and a value, with a colon between them, or the one word `revert`:
  - `label:bug` matches a label named `bug`. The whole name must match.
  - `title:fix` matches a title that starts with the word `fix`. It matches "fix: crash", "Fix the crash" and "fix(cli): crash". It does not match "Fixture for tests" or "Add prefix fixer", because a prefix is not "contains", and the word must end where the prefix ends.
  - `title_after_key:fix` works like `title:fix`, but first skips a ticket key at the start of the title. Many teams start a title with a key, such as "T-170: Fix the crash", so `title:fix` never matches them. A key is letters and digits, a hyphen, and digits, such as `T-170` or `KEY-123`, or `#` and digits, such as `#79`. It may be in square brackets or parentheses. A bare key needs a colon, a comma or a space after it, so "T-170Fix" keeps its key. A key in brackets needs nothing after it, so "[T-170]Fix" matches. A dash may follow a key too, but after a bare key the dash needs a space before it, so "T-170-Fix" keeps its key. More than one key may come first. So `title_after_key:fix` matches "T-170: Fix the crash", "KEY-123: fix the parser", "[KEY-123] fix the parser", "T-170 - Fix the crash", "[T-170] - Fix the crash", "T-170 : Fix the crash", "T-170, T-171: Fix", "T-170: [T-171] Fix" and "#79: Fix the crash". It does not match "T-170: Add prefix fixer" or "T-170: Improve fixtures", by the same word rule as `title:`. A title with no key matches the same way as with `title:fix`. A number alone, such as "79:", is not a key. A word with the shape of a key is skipped as a key: "FIX-12: Add a page" and "fix-12: crash" match `title:fix` but not `title_after_key:fix`. This type is not in the defaults: a person adds it to `fix_signals`, for example `[label:bug, title_after_key:fix, branch:fix/]`.
  - `branch:fix/` matches a head branch whose name starts with `fix/`.
  - `pr:96` matches the PR with the number 96. Many teams name a bug by its symptom, such as "T-170: tasks.test.js can hang in CI", with no label and no fix word, so no other signal finds it. With `pr:`, a person names the fix PRs by hand, one signal for each, for example `[label:bug, title:fix, branch:fix/, pr:96, pr:99]`. This is how section 12, phase A, marks escaped defects. The value is a PR number of 1 or more, with no leading zero, no `#` and no space. A range or a file of numbers is not a signal. A `pr:` signal adds to the others like any signal: a PR is a fix when any signal matches, and `fix_signal` is the first one in the list that matches. So a PR with the label `bug` in `[label:bug, pr:96]` has `fix_signal` `label:bug`.
  - `revert` matches a revert PR. A revert names the PR that brought the bug, so it needs no bug label and no blame guess (section 9.2, "Reverts"). A PR is a revert when its title starts with `Revert "`, the form that GitHub's Revert button and `git revert` write, or when its body has a line that starts with `Reverts owner/name#N` (GitHub's Revert button) or `This reverts commit <sha>` (`git revert`, with a SHA of 7 to 40 hex characters). The `Reverts owner/name#N` line counts only when `owner/name` is the PR's own repo, in any case. So a dependency bump whose copied release notes say "Reverts lodash/lodash#5000" is no revert. `exhibit check` without `--pr` knows no title and no body, so `revert` never matches there. A title such as "Add a revert button" or "Reverted state after save" is not a revert, and neither is a body that uses the word inside a sentence. A revert of a revert puts the work back (a re-land), so it is no fix: a title that starts with `Revert "Revert "` or `Reapply "` (newer `git revert` writes that) never matches. `revert` has no value: `revert:x` is refused. It is not in the defaults, because a revert is not always a bug. Put it first in the list to get the direct link for a revert that also has a bug label, because the first signal that matches is recorded, and SZZ takes the direct link only when that signal is `revert`.
  - `tracker:jira` asks Jira whether the PR's ticket is a bug. Many teams track bugs in a tracker, not in GitHub labels, so no other signal finds their fixes. The PR names its ticket by a key at the start of its title, found as `title_after_key` finds keys, or else at the start of its branch name, such as `PAY-482-fix-crash` or `PAY-482/crash`. A `#79` key is a GitHub number, not a Jira key, so it is skipped. Exhibit asks Jira for that issue (`GET /rest/api/2/issue/{key}` on `settings.jira.site`), and the PR is a fix when the issue type is in `settings.jira.issue_types`, `[Bug]` by default. Then `fix_signal` is the issue, such as `jira:PAY-482`. With `found_field` and `escaped_values` set, the classification gets `escaped`: `false` when the field has a value and none of its values is in `escaped_values`, such as a bug found in QA, and `true` when one is. A field with no value gives no `escaped`, so the bug counts as escaped, as before. Jira is asked only when no signal before `tracker:jira` in the list matched, and each issue at most once per run. So in `[label:bug, tracker:jira]`, a PR with the label `bug` costs no Jira request. A kept line (section 8.3) is classified again on each run too, so it asks Jira again. The token comes from the env variable `JIRA_API_TOKEN`. With `JIRA_EMAIL` set too, Exhibit sends the email and the token with Basic auth, as Jira Cloud needs for an API token. With the token alone, it sends a Bearer token, as a Jira Data Center personal access token needs. The token goes only in that header, so it is in no output, log, history line or report. Without `JIRA_API_TOKEN`, the signal matches no PR, the run still succeeds, and `exhibit history` says so in one line on stderr. A key that Jira does not know (404) does not match and does not stop the run. A Jira answer of 5xx, or another error for one issue, is handled as a GitHub 5xx in SZZ (section 9.2): the signal does not match that PR, a warning names the PR and the reason, and the run goes on. A 401, 403 or 429 stops the run. So does a site that cannot be reached, and a reply with no issue type or created date, such as a login page: a wrong site or a login page gives that reply for every key, so every later request would fail too. At the end, `exhibit history` says how many Jira requests it made, and how many named an issue that Jira does not know. `--json` gives them as `jira: { requests, not_found }`, or `jira: null` with no token. `exhibit check` does not ask Jira yet, so there `tracker:jira` matches no PR. Linear, GitHub issues and other trackers can come later as other tracker modules with the same methods (`src/jira.js` is the first).
  - All matching ignores case.
- The signals come from `settings.fix_signals` in `evidence.yml`. With no `evidence.yml`, or no `settings.fix_signals` in it, Exhibit uses `[label:bug, title:fix, branch:fix/]`. A custom list replaces these defaults. `exhibit history` reads and checks the whole file (section 8.1), so it refuses an invalid policy even when `fix_signals` is fine.
- A `fix_signals` that is not a list, is empty, has a signal that does not start with `label:`, `title:`, `title_after_key:`, `branch:`, `pr:` or `tracker:` and is not the word `revert`, has a `tracker:` signal other than `tracker:jira`, has a space before or after the value (such as "label: bug"), has a `pr:` value that is not a PR number (such as `pr:`, `pr:abc`, `pr:-3` or `pr:096`), or has the same `pr:` signal twice (such as `[pr:96, pr:96]`) makes `exhibit history` exit 2 with a message. A file that is not valid YAML does too. The message for a repeat names both places. A repeat does no harm, because the first match wins, but it is most often a typo for another number, and that PR would then not be a fix. In a YAML list, `pr: 96` with no quotes is a mapping, not text, so the message says to write `pr:96`.
- When `fix_signals` change, the next `exhibit history` run classifies every line again (section 8.3). A kept line is classified from the `title`, `body` and `labels` in the list of merged PRs, which every run reads, so `revert` needs no new request. `tracker:jira` asks Jira again for a kept line (see above).
- A linked issue with a bug label is a later signal type. The REST API does not give linked issues directly.
- A PR counts as a feature when a `feature` label is set, or when it adds a file under a source path. For the label, the name must match, and case does not matter. The source paths are the globs in `settings.source_paths`, matched as the globs of a kind are. A PR adds a file when the file is in the head, is not in the merge base, and git does not pair it with a removed file as a rename. `exhibit check` asks git for these files with `--find-renames`, which pairs a removed file and a new file when they are at least 50% alike. So a file that moves, or is renamed, with few changes is not added. A file that moves and also changes more than half of its content is added. A file that only changes is not added either. A file that moves into a source path from outside it, with few changes, is a rename too, so it is not added. With no `source_paths`, only the label marks a feature. For example, with `source_paths: ["src/**"]`, a PR that adds `src/cache.js` is a feature, and a PR that only changes `src/app.js`, or moves it to `src/main.js`, is not.
- `exhibit check --pr N` gets the title, body, labels and branch from the forge, and passes `--repo` to the `revert` signal. Without `--pr`, it knows only the local branch name: the `--head` ref when it names a local branch, or the checked-out branch when the head is `HEAD`. A fix or feature that only the title, the body or a label shows is then not seen, and `summary.md` says so.
- A change matches a kind when any changed path matches any glob in its `match`. In a glob, `*` matches any characters inside one folder name, `**` as a whole folder name matches any number of folders, and `?` matches one character that is not a slash. A glob matches the whole path, from the top of the repo.
- When no kind matches and the policy has no `default`, the change has risk `high` and no requirements, and the verdict is `needs_person` with a gap of type `no-rule`. A change with no changed files, such as a base and head that are the same commit, matches no kind either. So the `default` needs apply to it, or, with no `default`, it gets the `no-rule` gap.

### 9.2 SZZ

`exhibit history` runs SZZ only when it runs inside a clone of the repo: a git repo with a remote that points at the repo on GitHub, in any URL form. Otherwise it writes `szz: null` on every line and says so in one line on stderr. The run still succeeds.

1. For each fix PR, take the lines it deleted or changed. These are the old lines in `git diff -U0 -M` from the main branch just before the fix (step 3 says which commit that is) to `merge_sha`. A renamed file keeps its old path. A line the fix only added has nothing to blame.
2. Drop the lines that carry no bug. Each added line in the diff can explain one dropped line at most. A hunk shows only the changed lines, so Exhibit also reads each changed JavaScript, TypeScript and Python file whole, at the commit that blame runs on (step 3) and at `merge_sha`, in one `git cat-file --batch` call. The file says what the hunk cannot: whether a line starts inside a block comment, and how deep a Python line's block is. When git cannot read a file, the rules guess from the hunk alone, as said below. Exhibit checks the rules in this order:
   - **Whitespace.** The same hunk adds the line back, and only whitespace differs. A blank line is whitespace too, unless it moved. In a Python file the indent at the start of a line is code, because it says which block the line is in, so a line whose block depth changes counts. Exhibit compares the depth of the block, not the indent's characters. So a change from a tab to four spaces at the same depth, such as `\treturn t` to `    return t` when the whole function changed to spaces, is whitespace. A line inside brackets, a triple-quoted string or after a backslash at the end of the line before has no indent that counts. To find the depth, a tab moves to the next multiple of eight columns, as in Python. Without the file, the indent's characters must stay the same. In a JavaScript, TypeScript or Python file, whitespace inside a string is code too, because it changes the text the program makes: `'Total:'` to `'Total: '` counts. Code inside `${ }` in a template literal is code, not string text, so `${ a }` to `${a}` is whitespace. In JavaScript and TypeScript a regex literal is code, found as for the comment rule below, so a quote or a `{` in a regex opens nothing. So `x = /'/.test(s) ? 'a b' : c;` changed to `'ab'` counts, and so does `` s = `${ a.replace(/{/, '') } y z`; `` changed to `yz`. Exhibit reads each line alone, so the next line of a string that spans lines, such as a template literal, reads as code. A quote mark that opens no string, such as an apostrophe in JSX text, opens one that the next quote mark ends. These limits can make a line count, and sometimes drop a change inside a string, as `git diff -w` does. For example, in `<p>Don't {t('a b')}</p>` the apostrophe opens a string that ends at the quote before `a b`, so `'a b'` changed to `'ab'` is dropped as whitespace. A division that reads as a regex, such as `x++ / 2` or `obj.of / 2`, can do the same when a later string on the line has a `/` in it: in `y = x++ / 2 + 'a / b' + 'c d';`, `'c d'` changed to `'cd'` is dropped. In other files, whitespace inside quotes is whitespace, as in `git diff -w`.
   - **Moved.** The line is in a moved block: lines next to each other that another hunk, in the same file or another file, adds back next to each other in the same order. Only whitespace may differ, as for the whitespace rule: in a Python file the line must stay at the same block depth, and in a JavaScript, TypeScript or Python file the whitespace inside a string must stay the same. The block needs two or more lines with a letter or a digit. Short lines such as `}` or `"count": 4` are in many places, so they must not pair with the same text in an unrelated place. So one moved line, such as `return null;` deleted in one place and added in another, still counts: a real fix can do that. A blank line that another hunk adds back is moved too. A line that the same hunk adds back with the very same text is moved too: only its place changed. A line that its own hunk adds back, with the very same text or with only whitespace changed, does not split a moved block. The block can pass over that line. The block does not move that line, so the line does not count toward the two lines with words: the block needs two lines with words that no other rule drops. The line keeps its own reason, and its hunk keeps the added line it paired with. The block leaves the line's match in the other hunk unused, so another moved block can still take it. When two blocks need the same added line, the first block in the diff gets it. For example, the hunk at line 10 deletes `a();`, `b();`, `c();` and `d();` and adds `b();`, and another hunk adds all four lines. Lines 10 to 13 are a moved block. Without this, `a();` would be a block with one line of words, so it would count. A block starts only at a line that its own hunk does not add back, so a block that its own hunk adds back in full does not move: its lines stay whitespace, or moved inside the hunk. When the other hunk is in the same file and the fix changes nothing else, the next sentences then count all four lines. But when no line is left after this step, and some lines with a letter or a digit moved inside their own file, those lines count. The fix changed only their place, so their place was the bug. A moved line with no letter or digit, such as `});` or a blank line, stays dropped. A moved line that is only a comment stays dropped too, because a comment carries no bug. For example, a hunk that deletes `// note` and `x=1;` and adds `x = 1;` and `// note` counts no line. For example, chalk/chalk PR 569 "Fix exported styles names" only moves four export lines and a blank line up its file, so the four export lines count. A fix that only moves lines to another file still gets no link.
   - **Comment.** The line is only a comment, and the fix does not turn it back into code. A commented-out line that the fix makes code again counts, because the PR that commented it out may have brought the bug. Version 1 knows comments in JavaScript and TypeScript (`//` and `/* */`, in `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts` and `.cts` files) and in Python (`#`, in `.py` files). A hunk shows only changed lines, so a block comment can open before the hunk. The whole file says whether it did, so a JSDoc text line such as ` * Pads a label.` is a comment even when its `/**` and `*/` are outside the hunk. To read the file, Exhibit skips text in quotes, so `'src/**/*.js'` opens no comment. It reads a regex literal as code, so a `/*` inside one, such as `/[/*]/`, is a rare wrong guess. A backtick inside a regex literal, such as ``/`/``, is a second known wrong guess: Exhibit reads it as the start of a template string, which goes on, over many lines, until the next backtick. This guess can go two ways. It can miss a block comment that opens after the regex, so a comment line counts. Or the next backtick opens a real template string, and Exhibit reads that string's text as code. A `/*` in that text then opens a block, so the code lines after it read as a comment and are dropped. For example, after ``const re = /`/;`` and ``const s = `a /* b`;``, the line `x = 1;` changed to `x = 2;` is dropped as a comment. Without the file, a line that starts with `*` is a comment only when it ends the block with `*/`, when a later line of the hunk closes the block, or when it is a JSDoc tag such as `* @param`. The words of a Python comment are checked against the added code with no whitespace at all, so the indent does not stop a commented-out line from counting. Code can start with `*` too, such as `* qty;` on the line after `const total = price`. A later line closes the block when it starts with `*/`, or when it starts with `*`, ends with `*/` and has no `/*` before that `*/`. So `foo(); /* note */` does not close a block, because it opens its own comment, and the regex line `const re = /a*/` does not close one either. Only a closing line before the first later line that opens a block with `/*` counts, because a `*/` after that line closes the new block, not one from before the hunk. A line that starts with `*` or `//` opens no block, even when its text names `/*`, such as ` * Use '/*' to open.`. So in the deleted lines ` * qty;`, `/* a` and ` * b */`, the line ` * qty;` counts.
     A code line where only the comment at its end changed is dropped as a comment too, such as `x = 1; // old note` changed to `x = 1;`, or `x = 1;` changed to `x = 1; // why`. Exhibit takes the comments off the deleted line and off each added line in the same hunk. It reads each line with the path of its own side, so when a rename changes the language, such as `a.py` to `a.js`, a `#` is a comment only on the old line and a `//` only on the new line. When an added code line then has the same code, with at most whitespace changed, the deleted line is dropped. In a Python file the depth of the block must stay the same, as for the whitespace rule. A `//`, `#` or `/*` inside quotes is code, so `url = 'a // b'` changed to `url = 'a // c'` counts. In JavaScript and TypeScript a regex literal is code too, so the quote in `r = /'/; // n` opens no string, and that line changed to `r = /'/;` is dropped. A `/` is a regex when it comes at the start of the line, after a mark such as `=`, `(` or `,`, or after a word such as `return`. A `//` in JSX text, with a closing tag such as `</p>` later on the line, is text too, so `<p>Price // 10 USD</p>` changed to `<p>Price // 20 USD</p>` counts. A comment mark counts only at the start of the line or after a space, because a line can be part of a string that opened on an earlier line, such as `http://a.example` in a template string. Exhibit reads each line alone, so other text that only looks like a comment is still dropped as one: a `#` in a Python docstring, such as ` Use # for x` changed to ` Use # for y`, a `//` in a template literal that spans lines, such as ` WHERE id = 1 // ok` changed to ` WHERE id = 1 // no`, and a `//` in JSX text with no closing tag after it on the line. Two rare guesses go the other way and only keep a line: a comment that names a closing tag, such as `x = 1; // see </p>`, reads as JSX text, and a division after `++` or `--`, such as `x++ / 2`, reads as the start of a regex.

   A fix that mixes a real change with these changes keeps only the real lines.
3. Run `git blame` on the parent of the fix's first commit on the main branch, to find the commit that last changed each line. That parent is the main branch just before the fix, so the line numbers match the diff in step 1. A merge commit or a squash merge puts the fix on main as one commit, so this is the first parent of `merge_sha`. "Rebase and merge" copies each of the fix's commits onto main, and `merge_sha` is only the last copy. So Exhibit walks back from `merge_sha` along first parents while the parent commit belongs to the fix PR (mapped as in step 4), and blames the parent of the oldest one. For a merge commit or a squash merge, the walk stops at once, and the parent is often another PR's `merge_sha`, so it costs no request for its pull requests. Git runs with settings that ignore a clone's own diff and blame config, such as `blame.ignoreRevsFile`.
4. Map each commit to its PR. Only a PR merged into the repo's default branch (`default_branch` from `GET /repos/{repo}`) brought a commit to main. Exhibit asks for the default branch once per run. First, a commit that is the `merge_sha` of a PR in the history belongs to that PR, when the PR's `base_ref` is the default branch: a squash merge into main. It also belongs to that PR when the commit is on the first-parent line of the default branch in the clone, whatever `base_ref` says. This is for a repo that renamed its default branch, for example from `master` to `main`: the PRs merged before the rename keep `base_ref` `master`, but their squash commits are on main. So they cost no request, and they keep their link even when GitHub lists no PR for the commit. To find the line, Exhibit takes the tip of the default branch of a remote that points at the repo on GitHub, such as `origin/main`, or else the local branch with that name, and runs `git rev-list --first-parent` once per run. A PR squash merged into a release branch, which a merge commit later brought to main, is not on that line, so GitHub is asked about it. When the clone has no branch with the default branch's name, or when git fails to list the line, no commit is on the line, so GitHub is asked. A branch that main took by fast-forward, with no merge commit, is on the line too. For example, after `develop` is pushed to main by hand, a squash commit into `develop` is on the line, so its merge SHA decides. GitHub never fast-forwards when it merges a PR, so only a push to main by hand does this. When no merge SHA decides, Exhibit asks GitHub for the pull requests that hold the commit, and keeps one merged PR. When only one merged PR holds the commit, that PR wins. When more than one does, the first one merged into the default branch wins. So a fix merged into a release branch, and later brought to main by a PR that merges the release branch, maps to that later PR, both for a merge commit and for a squash merge into the release branch. When none of them went to the default branch, the first one merged wins. This also happens after a repo renames its default branch, for example from `master` to `main`, for a commit that is not a `merge_sha` in the history: older PRs keep their old `base.ref`, so for them the first one merged wins, as it did before. Exhibit asks once for each commit. A commit that no merged PR holds, or that GitHub does not know (a 422 or 404 reply), goes to `unlinked_lines`.
5. Drop introducing commits that are newer than the bug report, when the bug report has a date. The bug report is an issue that the fix PR's body links with one of GitHub's closing words, such as "Fixes #12", "closes: #7", "Fixes owner/name#12" or "Fixes https://github.com/owner/name/issues/12". The "owner/name#12" form and a full issue URL count only when they name the same repo. Case does not matter in the repo name. A repo keeps working under its old name after a rename or a transfer: GitHub redirects the old name, and the closing word still closes the issue. So when the name is not the repo's current name, Exhibit asks GitHub for that repo (`GET /repos/{owner}/{name}`, which follows the redirect), and counts the issue when the reply has the same `id` as the repo itself. For example, "Fixes oldowner/repo#12" in the repo now called `newowner/repo` links issue 12. A name that the token cannot read names another repo, so a stray mention of such a repo never stops the run: GitHub does not know it (a 404), or refuses it with a 403 that is not a rate limit, such as a private repo behind SAML SSO, or with another 4xx, such as a 451 for a repo blocked for legal reasons. A 5xx names another repo for that fix too. A refused token (401) and a rate limit (429, or a 403 with no requests left) still stop the run, as below. Exhibit asks once for each name in a run, in upper or lower case, so `Joyent/Node` and `joyent/node` share one answer. A 5xx answer is not kept, so the request is asked again for the next fix that names that repo. Exhibit asks GitHub for each linked issue and takes its creation time. A line whose commit was written (its `author_time`) after that time is dropped. When the body links more than one issue, the newest one counts. A linked number that is a PR, or that GitHub does not know, gives no date. Issues in other repos are not read. When the linked GitHub issues give no date, and the fix was found by `tracker:jira` (its `fix_signal` is a Jira issue, such as `jira:PAY-482`), the Jira issue's created time is the bug report date. The fix signal asked Jira for that issue already, so this sends no new request.
6. Give each link a confidence score: the number of the fix's lines that point to that PR, divided by all of the fix's counted lines. Dropped lines are not in the count. Unlinked lines are, so the scores add up to 1 only when every line has a PR.

A fix with no lines left after steps 2 and 5 gets no links, and its `no_link_reason` says why (section 8.3).

**Reverts.** When a fix's `fix_signal` is `revert`, SZZ skips steps 1 to 6. It blames no line, so `blamed_commit` is null, and the fix's merge commit need not be in the clone. Instead it links the work that the revert's body names, straight away:

- A PR named as `Reverts owner/name#N` is linked when `owner/name` is this repo (in any case), and when the history holds PR N or the forge says that N is a PR. A PR in another repo is not linked.
- A commit named as `This reverts commit <sha>` maps to its PR as in step 4: a `merge_sha` in the history first, then the forge. A short SHA is first looked up in the clone.
- Each linked PR gets `found_by: "revert"` and no `lines`. A PR named twice, for example by number and by its merge commit, is one link. The revert PR itself is never a link.
- A found PR whose history line is itself a revert (by the rule in section 9.1) is not linked. A person can click Revert on a revert and rename the title, for example to "Reland: add cache". The body still says "Reverts owner/name#200", and PR 200 is the revert, not the bug. When every found PR is a revert, the fix has no links, and `no_link_reason` is "reverts a revert".
- One linked PR gets confidence 1. A revert that names more than one PR links each one, and the confidences are split evenly: two PRs get 0.5 each.
- When SZZ finds no PR in this repo that the revert names, as for a title-only revert or a body that names only another repo's PR, the fix has no links, and `no_link_reason` is "reverted change not found".

For example, PR 200 on timonrieger/homelab is "Revert \"Test deploy: add label to immichframe\"" with the body "Reverts timonrieger/homelab#199". With `revert` in `fix_signals`, its `szz` has one link: PR 199, confidence 1, `found_by` `revert`. The history held PR 199, so this cost no request.

A forge error on one of these requests skips the fix, as the next paragraph says for any fix.

When a fix's `merge_sha` is not in the clone, a git command fails for that fix, or GitHub answers an error for one of its requests (the linked issue, the pull requests of a commit, or the repo's default branch), Exhibit writes `szz: null` for that PR, prints a warning that names it and the reason, and goes on with the other PRs. A GitHub answer of 401 (a refused token), 403 (a missing permission or a rate limit) or 429 (a rate limit) still stops the run, because every later request would fail too. So does a reply that is not the JSON GitHub should send, and a request that cannot reach GitHub at all. The summary at the end counts these skipped fix PRs, for example "SZZ found links for 0 of 1 fix PRs (1 skipped)", and `--json` gives the count as `szz.skipped`. In a shallow clone, such as the default checkout in GitHub Actions, it prints one warning first: blame there can give old lines to the shallow boundary commit, so links can be wrong. A change to a submodule pointer has no lines, so SZZ skips it.

Every link is shown with its lines and blame output. In `exhibit label`, the person can reject it.

### 9.3 Tests on the base and the head

- Exhibit makes two clean git worktrees in the temp folder, one for the base and one for the head, and runs `settings.test_command` in each, in a shell, with the worktree as its folder. A worktree holds only the files of its commit, so the base run does not see the head, and neither run sees edits in the checkout that are not committed. Files that git ignores, such as `node_modules`, are not there either, so the command must install what the tests need, for example `npm ci && node --test ...`.
- Test results come from the JUnit XML file at `settings.test_results`, a path in the worktree. Exhibit removes the file before each run and makes its folder. Most runners can write JUnit, including `node:test`, Jest, Vitest and pytest. TAP is a later option.
- When a test fails, Exhibit runs the test command once more. A test whose two runs disagree, for example it fails and then passes, is flaky. It is listed in `flaky_tests`, and it never counts as evidence in either direction.
- The requirement is `met` when every test passes on the head, apart from flaky and skipped ones. It is `failed` when any test fails on the head on both runs, and the gap names those tests. It is `missing` when the policy has no `test_command` or no `test_results`, or when no test passes on the head: the JUnit file lists no tests, or only skipped or flaky ones. It is `error`, and so is the verdict, when `test_results` is not a path inside the repo (an absolute path, or one that starts with `..`), when the command cannot run (the shell exits 127), when it writes no JUnit file, when the file is not JUnit XML, or when the command fails but the file names no failing test.
- `details` gives the count of passed, failed, skipped and flaky tests on the base and on the head, and `failed_on_head`, the names of the tests that fail on the head.
- Exhibit removes both worktrees after the run, also when the run fails.
- Exhibit keeps the per-test results of the base and the head for the rest of the run. The tests run only once, and the failing-before check (section 9.4) uses the same results. That check adds one more run of its own: the base code with the PR's test files.

### 9.4 A test that failed before

The `failing-before` requirement proves that a test in the PR would have caught the problem: the test fails on the old code and passes on the new.

- The PR's test files are the changed files that look like tests: a name such as `*.test.*`, `*.spec.*`, `test_*.py` or `*_test.*`, or a file in a folder named `test`, `tests`, `__tests__` or `spec`. Helpers and fixtures in those folders count too, because a new test can need them. A changed file that the head's JUnit file names as the file of a test counts as well.
- When the PR changes no test file, the requirement is `missing`, and Exhibit runs no more tests for it.
- Otherwise Exhibit makes one more clean worktree of the base. It puts in each of the PR's test files as it is on the head, removes the ones the head deleted, and runs the test command there, as in section 9.3, with a second run when a test fails. This is the run "on the base with the PR's test files". So a new test file, and a test that the PR changed, run against the old code.
- A test qualifies when all of these hold:
  - The PR added or changed it. Its file is one of the PR's test files, or it is not in the plain base run, or its result there differs from its result on the base with the PR's test files. Only the PR's test files differ between those two runs, so a test whose result changed is the PR's. Exhibit works per file: it does not tell a test the PR changed from a test beside it in the same changed file.
  - It fails on the base with the PR's test files, or its file could not load there.
  - It passes on the head.
  - It is not flaky in any of the three runs (section 9.3).
- A file can fail to load on the base, for example when it imports a module that the base lacks. Its tests then do not run. node:test writes one failed test case named after the file instead. Exhibit counts each test of that file that passes on the head as failing on the base, and says that it did not load. When the JUnit file gives no file for a test, as Node 20's reporter does, Exhibit cannot tell which file a test is in, so it names every PR test file that did not load.
- The requirement is `met` when at least one test qualifies. `details.tests` lists each one, with `on_base`: `failed`, or `did_not_load` and the `files` that did not load. `summary.md` names each test and which kind of failure it had on the base. The requirement is `missing` when no test qualifies. Its gap says to add a test that fails without the change and passes with it, and names the PR's tests that pass on the base too, in `details.passed_on_base`. `details` also gives `test_files` and `did_not_load_on_base`.
- When a test run cannot give results, the requirement gets the status and the gap of section 9.3: `missing` with no `test_command`, and `error` when the command cannot run or writes no JUnit file.

### 9.5 Mutation on changed lines

- Exhibit uses adapters for existing tools. Version 1 has two adapters: Stryker for JavaScript and TypeScript, and mutmut for Python. The Stryker adapter is built. mutmut comes later. Until then a change to a Python file makes a `mutation` requirement `skipped`, and so does a change to code in a language that no adapter covers, such as Go or Java. Files with no code, such as docs and config, are not mutated.
- The changed lines are the lines that `git diff` shows as added or changed on the head, from the merge base of the base and the head. A line that the change only removed is not on the head, so nothing is mutated for it. Stryker gets each run of changed lines as a range, such as `src/a.js:3-5`, and makes mutants only there. Exhibit never mutates a test file: a file that section 9.4 calls a test file, or one that `settings.mutation_test_files` matches.
- When the change has no changed line of JavaScript or TypeScript outside the tests, there is nothing to mutate. The requirement is then `met`, and `details.reason` says why.
- The Stryker adapter needs `settings.mutation_test_files`: globs of the test files, such as `["test/**/*.test.js"]`. Without it, the requirement is `missing`. Each test file must run as `node FILE` and print TAP, as a `node:test` file does.
- Exhibit makes a clean worktree of the head, and runs `settings.mutation_setup` there with `sh`, such as `npm ci`, to install what the tests need. It has the time limit of a probe (`settings.probe_timeout_seconds`, section 9.6), and its output goes to `.exhibit/mutation/setup.log`. When it fails, the requirement is `error`.
- Exhibit runs only the tests that can reach a changed file, in two steps:
  1. By test file. Exhibit picks the test files that load a changed file through a chain of relative `import` and `require` calls, or that have a changed file's name in a string in that chain, as a test does that starts a server with `node relay/server.js`. When no test file reaches a changed file, it gives Stryker every test file.
  2. Per test. Stryker runs with its tap test runner and per-test coverage. The tap runner runs each test file in a node process of its own, and records which test files ran each mutant's code. Stryker then runs each mutant against only those files, and stops at the first one that fails.

  The reason is speed. Building58's whole suite takes about 47 minutes one file at a time, and Stryker's first run, which records the coverage, takes as long as all the test files it gets. Step 1 keeps that first run short, and step 2 keeps each mutant's run short. Per-test coverage sees only the code that runs in the test file's own process. A mutant whose code runs only in a child process, such as a server that the test starts, shows as not covered. It counts as survived, so this errs toward `needs_person`.
- Timeouts count as killed. So a test that is only slow must not count as a timeout: Stryker runs a test process on half the cores, and a mutant times out after 2.5 times the normal time of its tests plus 15 seconds. With Stryker's defaults, on a busy machine, mutants that changed nothing timed out and counted as killed. Mutants with no test coverage count as survived and are listed apart. A mutant that does not compile, or that breaks the code when it loads, is not valid and does not count. Neither does a mutant that Stryker ignored.
- `settings.mutation_budget_seconds` is the time budget of the Stryker run. It is 600 seconds when left out. When it runs out, Exhibit stops Stryker and every process it started, as it stops a probe (section 9.6). Exhibit's own Stryker reporter writes each mutant as soon as Stryker knows its status, so a stopped run still gives every mutant it finished. This is a partial run. When the budget runs out after Stryker has reported every mutant, the run is complete.
- The catch rate is killed mutants divided by killed plus survived mutants. `details.interval_95` is its 95% interval (Clopper-Pearson, `src/interval.js`). After a complete run, every mutant on the changed lines is counted. The requirement is then `met` when the catch rate reaches `min`, and `failed` when it does not. After a partial run, the mutants are a sample. The requirement is then `met` only when the lower bound of the interval reaches `min`. It is `failed` when the upper bound is below `min`, and `missing` when the interval holds `min`, because the sample is too small to tell. A partial run that finished no mutant is `missing` too. Stryker tests the mutants file by file, in the order of the code, so a sample holds more of the first changed lines than of the last.
- A mutant status that Exhibit does not know, which a Stryker upgrade could bring, gives `error`.
- When Stryker exits before it is done for any other reason, for example because a test fails on the head, the requirement is `error`, never `met` (section 14). Stryker's output goes to `.exhibit/mutation/output.log`. `exhibit check` removes the old `.exhibit/mutation` folder when it starts.
- `details` gives `killed`, `timeout`, `survived`, `no_coverage`, `not_valid`, `ignored`, `n` (the mutants that count: killed, timeouts, survived and not covered), `catch_rate`, `interval_95`, `complete`, `budget_seconds`, `mutated` (each file with its ranges of changed lines), `test_files`, `test_selection` (`reach`, or `all` when no test file reached a changed file) and `output`. It lists the surviving mutants in `survivors`, apart from them the mutants that no test reached in `no_coverage_mutants`, and the mutants killed by a timeout in `timeout_mutants`, so a person can check that each one really makes the tests hang. Each one has its `file`, `line`, `column`, `mutator`, the `original` code and its `replacement`. `summary.md` gives the catch rate with n and the interval, and lists up to 20 mutants of each list, each with its file, line and change.
- Two runs on the same commits give the same mutants when the tests give the same results each time. A partial run can stop at a different mutant.
- Some surviving mutants are equivalent to the original code. The summary lists the survivors so a person can mark one as equivalent. Marked mutants drop out of later runs on the same code. This part is not built yet.

### 9.6 Probes

A probe runs its command in the head worktree with a time limit. Its status comes from the exit code and the declared artifacts. Exhibit attaches the artifacts to the check and links them from `summary.md`.

- The head worktree is a clean git worktree of the head commit in a temporary folder. Exhibit makes it only when the change needs a probe, and removes it at the end of the run. Before each probe after the first, Exhibit makes it clean again: it checks out the head commit with `--force`, and removes every file that git does not track, ignored files too (`git clean -ffdx`). So no probe sees the files of the probe before it, and a hidden probe's files cannot reach the exhibit through a later probe. The worktree has no files that git ignores, such as `node_modules`, so a probe that needs them installs them first, for example `npm ci && npm run lint`. Each probe installs them again, because of the clean step.
- The command runs with `sh`, in a process group of its own. Its standard output and standard error go to `.exhibit/probes/NAME/output.log`, so a person can read why it failed. NAME is the probe's name, with each character that is not a letter, a digit, `.`, `-` or `_` changed to `-`. When two probes get the same NAME, the later one gets `-2`, `-3` and so on.
- The time limit is `settings.probe_timeout_seconds` in `evidence.yml`. The default is 600 seconds (10 minutes). When the command runs past it, Exhibit kills the whole process group, so no process of the probe keeps running. Exhibit also kills the group when the command exits, so a server that the probe started and left behind stops too. This works only for processes that stay in the group: a process that leaves it, for example with `setsid` or by turning itself into a daemon, keeps running.
- The probe is `met` when the command exits 0 and every declared artifact exists. It is `failed` when the command exits with another code, is stopped by a signal, runs past the time limit, or exits 0 without writing an artifact. The gap's `how_to_fix` says which: the exit code, the artifacts that are missing, or that it timed out.
- An artifact path is relative to the root of the head worktree. A path that leads outside the worktree, by `..`, an absolute path or a symbolic link, counts as missing.
- Exhibit copies each artifact that exists to `.exhibit/probes/NAME/artifacts/PATH`, also when the probe failed. An artifact can be a folder. Exhibit copies a symbolic link inside it as the file it points to, but only when that file is inside the worktree. It leaves out a link that leads outside. `summary.md` links the output and each artifact on the probe's line.
- `details` holds `exit_code` (null when a signal stopped it), `timed_out`, `timeout_seconds`, `output` (the path of output.log), `artifacts` (each with its `path` and the `copy` in the exhibit) and `missing_artifacts`.
- `exhibit check` removes the old `.exhibit/probes` folder when it starts, so no file from an earlier run is read as this run's evidence.

### 9.7 Who wrote each check

- Tests that the PR added or changed count as written by the builder. The `failing-before` requirement checks only those tests, so it always counts as `builder` in `checks_by_author`. A `failing-before` that is not needed (section 9.8) checks nothing, so it does not count.
- Probes with `author: hidden` count as hidden in `checks_by_author`. Exhibit keeps only the status and the counts of a hidden probe. It does not save the command's output, and it does not copy its artifacts, so `details` has no `output` and no `artifacts`, and `summary.md` has no links for it.
- A hidden suite lives outside the PR's repo. CI fetches it with a secret that a PR from a fork never gets. Exhibit only reads the counts. It never copies hidden tests into the exhibit.

### 9.8 Verdict

- `meets_policy` when every requirement is `met`, and there is no other gap. Exit code 0.
- `needs_person` when any requirement is `missing`, `failed` or `skipped`, when the change touches the policy file (sections 8.2 and 15; the change is checked by the policy in the base commit, section 8.1), or when no rule covers the change (section 9.1). Exit code 1. A `skipped` requirement counts as not met: Exhibit did not check it, so a person must.
- One `skipped` does not count: a `failing-before` whose `when` limits it to a fix or a feature, on a change that is neither. The policy does not need it for that change, so it is no gap, and the change can still get `meets_policy`. Its line in `summary.md` gives the reason.
- `error` when Exhibit itself failed: a collector threw, or gave back no valid status, so its requirement is `error`. Exit code 2. An error never becomes `meets_policy`, and it wins over `needs_person`.
- A failure before Exhibit can build the exhibit, such as a bad policy, a ref that is not in the clone, or any unexpected throw, also exits 2. `exhibit check` removes the old `evidence.json` and `summary.md` when it starts, so no old verdict is left behind, and it prints `verdict: error` on stderr.
- `summary.md` gives the verdict and the exit code, the kinds, the risk, fix and feature, each requirement with its status, and each gap with how to fix it, in plain words. It holds no time, so two runs on the same commits give the same file.

### 9.9 Backtest

- The test set is the PRs merged after `--from`.
- Leak check: a rule whose `source` includes a defect from the test set is a leak. The report names it and gives results with and without that rule.
- For each PR in the test set, Exhibit works out what the policy would have required. It compares that with the PR's exhibit if there is one, or with the evidence section of its body. With `--rerun`, it runs the cheap requirements again on the PR's historical base and head.
- Caught: the introducing PR of a test-set defect would have been `needs_person`. Strong catch: the missing requirement matches the defect's category.
- Missed: the introducing PR would have been `meets_policy`.
- False demand: a PR with no escaped defect would have been `needs_person`.
- The report gives these counts for each kind of change, with 95% intervals. It goes to `.exhibit/backtest.md` and `.exhibit/backtest.html` (section 8.5).

The report also gives four measures. Each one comes from "How the Claude Code team thinks about verification" (section 17.2).

**1. False demands on size-matched clean PRs.** Here an introducing PR is a PR in the test set with a link that a person kept in `exhibit label` (section 8.4). A clean PR is a PR in the test set with no SZZ link to any fix, or whose every link a person rejected. A PR with no kept link and at least one SZZ link that nobody has labeled yet is neither: it is in no rate and starts no match, and the report gives how many such PRs there are for each kind of change. A kept link wins, so a PR with one kept link and one unlabeled link is an introducing PR. Small PRs are easy to pass, and most clean PRs are small. So a false-demand rate over all clean PRs looks better than it is. Exhibit also counts false demands on a size-matched set: the clean PRs whose size is close to the size of the introducing PRs.

- The size of a PR is its changed lines: the sum of `additions` and `deletions` over its `files` in `history.jsonl` (section 8.3).
- Exhibit makes the match inside each kind of change, because the report gives its counts for each kind. For each introducing PR in the test set that matches the kind, it takes the 3 clean PRs of that kind whose size is closest. A clean PR is taken at most once. The introducing PRs pick in order of PR number, lowest first. On a tie, it takes the PR with fewer changed files first, then the PR merged nearer in time to the introducing PR, then the lower PR number. So the same history gives the same set.
- When a kind has fewer clean PRs than 3 for each introducing PR, the set holds all of them, and the report says so.
- When a kind has no introducing PR in the test set, it has no size-matched set. The report shows only its rate over all clean PRs, and says why.
- The report gives both rates for each kind, each with its n and its 95% interval: false demands over all clean PRs, and false demands over the size-matched set.

Example. One kind of change has 2 introducing PRs, with 40 and 300 changed lines, and 11 clean PRs, with 2, 3, 5, 8, 35, 45, 60, 250, 280, 320 and 900 changed lines. The policy would have made a false demand on the PRs with 250 and 320 lines.

| Introducing PR | Size-matched clean PRs | Distance |
|---|---|---|
| 40 lines | 35, 45, 60 | 5, 5, 20 |
| 300 lines | 280, 320, 250 | 20, 20, 50 |

Over all clean PRs, the false-demand rate is 2 of 11, or 18%. Over the size-matched set, it is 2 of 6, or 33%. The four PRs with fewer than 10 lines made the first rate look better.

**2. Each defect, replayed.** The report lists each labeled escaped defect (section 8.4) that has a kept introducing PR in the test set. A defect with more than one kept introducing PR gets one line for each. Each line gives the defect's `id`, its `category`, the introducing PR, and the verdict that the current policy would have given that PR. When the verdict is `needs_person`, the line names each requirement that would have been missing, and says whether it is a strong catch. When the verdict is `meets_policy`, the line says "missed". When a rule leaks (the leak check above), the line gives the verdict with and without that rule.

**3. The funnel.** One number from start to end hides where defects get lost. So the first screen of the backtest report shows how many defects are left at each step. Each step counts a part of the step before it, over all the history that the run read:

1. Fix PRs found (section 9.1).
2. Fix PRs with an SZZ link to an introducing PR (section 9.2).
3. Defects with a link that a person kept in `exhibit label` (section 8.4).
4. Defects named in a rule's `source` (section 8.1).
5. Defects that the policy would have flagged: the policy gives `needs_person` to at least one of the defect's kept introducing PRs.

Beside each step, the report gives how many were lost since the step before, and why, in plain words. For example: "4 fix PRs had no SZZ link", "2 defects are not labeled yet, and 1 had every link rejected", "3 defects are in no rule". Step 5 shows whether a rule still flags the bug it came from. It is not a test of the policy, because the rule learned from those defects. The test is the caught and missed counts on the test set, above.

Example: 30 fix PRs, 22 with an SZZ link, 15 with a kept link, 9 in a rule's `source`, 8 flagged.

**4. Rules that do not pay.** Rules only grow if nobody removes them. So for each kind of change, the report gives two counts on the test set:

- Caught: the defects whose kept introducing PR matches the kind, and would have been `needs_person` because a requirement of this kind was missing. A defect in the kind's own `source` does not count, because that is a leak.
- False demands: the clean PRs that match the kind, and would have been `needs_person` because a requirement of this kind was missing.

A kind with 0 caught and at least 1 false demand is marked "does not pay", with both counts and the number of test-set defects that matched the kind. With 0 matching defects, the kind had no chance to catch one, and the report says so. `default` gets the same counts. A person reads the mark and decides whether to remove the kind from `evidence.yml`, or to change its `needs`. Exhibit never removes or changes a rule itself.

### 9.10 Numbers for the trust ladder

For each kind of change, Exhibit reports:
- The number of PRs.
- Policy misses.
- The upper bound of the miss rate: 3/n when there are zero misses, and a Clopper-Pearson bound otherwise.
- The false-demand rate over the size-matched set of clean PRs (section 9.9), with its n. Small PRs are easy to pass, so this is the rate that a rung uses. Next to it, the rate over all clean PRs, with its n. When a kind has no size-matched set, only the second rate is shown, and the report says why.
- Results from the blind sample, when the person has recorded them.

Exhibit only reports these numbers. It never changes a rung.

### 9.11 Claude

- Claude is used only by `exhibit label --claude` and `exhibit policy suggest`.
- It needs `ANTHROPIC_API_KEY`. Every command works without it. `exhibit label --claude` with no key exits 2 before it shows anything, with a message that says to set the key or run without `--claude`.
- The model is `claude-opus-5-5` by default. Set `EXHIBIT_CLAUDE_MODEL` to use another one. Each draft keeps the name of the model that wrote it.
- For each defect, Claude reads what the person reads: the fix PR's title and body, and the defect text with the changed lines and the SZZ links with their evidence. It also gets the categories used so far, so it can reuse one. It answers with a code and a category in a fixed JSON form. A draft that does not fit the labels schema counts as a failed draft.
- The first time `--claude` runs in a repo, it says in one line what is sent to Anthropic's API: the fix PR's title and body, the changed lines, and what git blame says about them, which is the commit, the author's name and the commit message, and the titles of the linked PRs. It then writes `.exhibit/claude-notice-shown`, so the line does not show again.
- Each draft is marked as a draft until the person acts on it. A draft is never written as a label by itself.
- An API error, a refusal, or a draft that does not fit is shown as a plain message, and the person labels that defect by hand. The labels already written stay.
- Exhibit records how often the person keeps Claude's draft unchanged: `labeled_by` and `claude_draft` in each line (section 8.4). That number measures the drafter, so the person can decide how far to trust the drafts.
- At the end of each `exhibit label --claude` run, it shows that number, from the labels lines alone, so it is the same each time it is worked out. It counts it twice: for the lines this run wrote, and for every line in `.exhibit/labels.jsonl`.
  - Drafts shown: the lines with `claude_draft`. A skipped defect, or a defect left when the person quit, has no line, so its draft is not counted. Nor is a draft that failed.
  - Kept unchanged: `claude_draft_confirmed`. Edited: `claude_draft_edited`, a change to the code, the category or both. Replaced: `person` with `claude_draft`, after `t`. A draft counts as kept only when both its code and its category are unchanged.
  - The kept share is kept divided by drafts shown, with its n and the exact 95% Clopper-Pearson interval, as in section 9.10. So 7 kept of 10 shown is 70%, with an interval of 34% to 94%. The text rounds the low end down and the high end up, so it never shows an interval narrower than the real one. The 2.5% tail sits on each side; with 0 kept the low end is 0, and with every draft kept the high end is 1.
  - With fewer than 10 drafts, it says the number is weak. With 9 it is weak, and with 10 it is not.
  - With no drafts, it says there are none and shows no share, not 0%.

### 9.12 Storage

`exhibit check` runs the PR's code, so in CI it runs with a read-only token. Storing its result needs write access. So `exhibit publish` is a separate step that never runs code from the PR. It stores one exhibit at `prs/<number>/<head-sha>.json`, where the number is the exhibit's `pr` and the SHA is its `head`.

The place is a setting, `settings.storage` in `evidence.yml`, and `--storage` wins over it. Some repos refuse pushes from CI, which is why it is a setting. Every write goes through one function, `store` in `src/storage.js`, with one entry for each place, so a CI artifact or a bucket can come later as one more entry.

- `data-branch`, the default, commits the file to the data branch on the remote (`--remote`, by default `origin`). The branch is `settings.data_branch` or `--data-branch`, by default `exhibit-data`.
  - It uses only git's plumbing: a blob, a tree made in a temporary index, and a commit, which it pushes. It never touches the working tree, the index or the checked-out branch, and it never pushes with force. Git updates the remote-tracking ref, such as `origin/exhibit-data`, as it does for any push.
  - When the remote has no data branch, it makes one with no shared history: its first commit has no parent.
  - When two runs publish at the same time, the push of the later one is refused. That run fetches the branch again, puts its commit on the new tip, and pushes again, up to 5 tries, and then exits 2. A push that is refused while the branch did not move is not a race, such as a remote that refuses pushes from CI, so it exits 2 after one more fetch, with git's reason.
  - When the branch already holds the same bytes at the path, it makes no commit and exits 0. A new exhibit for the same PR and head, such as one with a later `created_at`, replaces the old file in a new commit.
  - When git cannot name the author, as on a CI runner with no `user.name`, the commit is made by `Exhibit`. An identity variable that is set but empty, such as `GIT_AUTHOR_NAME=`, counts as not set. When git still cannot make the commit, publish exits 2 with git's reason.
- `local` writes the file to a folder, `settings.local_path` or `--local-path`, by default `.exhibit/out`, relative to the repo. It makes no git change. When the file already holds the same bytes, it writes nothing.

**The PR comment.** With `--comment`, publish posts a short summary of the exhibit as one comment on the PR, so a reviewer reads the verdict and the gaps without opening CI. Posting is a forge method, `upsertComment`, beside the others in the forge module.

- The comment starts with a hidden marker, `<!-- exhibit:pr-summary -->`. On each later run, publish updates the first comment that starts with the marker and that the token's own account wrote. It never changes a comment by anyone else, even one that starts with the marker. With no such comment, it posts a new one. When the comment already holds the same text, it changes nothing.
- The comment shows the verdict, the head commit, the kinds and the risk, and each gap with how to fix it. It shows at most the first 10 gaps, then says how many more there are. Without `--enforce`, it says "Shadow mode: nothing waits on this."
- It ends with a link to the full exhibit, on the data branch at the commit that holds it, when the remote is the PR's repo on GitHub. Otherwise it names the stored file.
- Publish checks for the repo, the PR number and `GITHUB_TOKEN` before it stores the exhibit, and a missing one gives exit 2 and stores nothing. It stores the exhibit before it posts the comment. A failure to post, such as a 403 from a token with no write permission, gives exit 2 and a message that says the exhibit is stored, and the stored exhibit stays. A fine-grained token needs the permission "Pull requests: write".
- A PR from a fork gets a token that cannot write, so the GitHub Action skips the publish job for it (section 10).

Later tickets add the rest of storage:

- The history cache and reports live on the data branch too.

## 10. GitHub Action

The Action is a thin wrapper over the CLI. `action.yml`, at the top of the repo, only maps its inputs to CLI flags, and the CLI's exit code is the step's exit code. Every decision, shadow mode too, is in the CLI, so a GitLab CI job can later be a second thin wrapper. `test/action.test.js` reads `action.yml` and runs its script to check this.

- `action.yml` is a composite action. It installs Exhibit's own packages with `npm ci`, then runs the CLI with the `node` on the job's PATH, which must be Node 20 or later, as on GitHub's runners. It does not set up Node itself: `exhibit check` runs the repo's own tests, and they must run on the Node that the repo set up.
- Inputs, each passed to the script as an environment variable, never pasted into it:
  - `command`: `check` (the default) or `publish`. `trace` and `history` come with slices S7 and S8.
  - `policy`: the path of the policy file in the repo, by default `evidence.yml`. It goes to `--policy`.
  - `data-branch`: for `publish`, it goes to `--data-branch`. Empty, the default, means `settings.data_branch`, or `exhibit-data`.
  - `comment`: true or false, by default false. For `publish`, true gives `--comment`.
  - `enforce`: true or false, by default false. False is shadow mode: `check` gets `--shadow`, so the step succeeds whatever the verdict. True fails the check step on `needs_person` and on `error`, and `publish` gets `--enforce`, so the comment does not say shadow mode.
  - `token`: the token for `GITHUB_TOKEN`, by default the job's own token.
  - A `command`, `comment` or `enforce` that is not one of its values fails the step with exit 2, and runs nothing.
- `check` runs `exhibit check --pr N --repo owner/name`, with the PR from the event. Then, whatever its exit code, the step writes `summary.md` to the job summary, and uploads `evidence.json`, `summary.md`, `.exhibit/probes/` and `.exhibit/mutation/` as the workflow artifact `exhibit`. The mutation folder holds the logs of `mutation_setup` and of Stryker (section 9.5), which a mutation gap tells the person to read. `summary.md` is there for a run that failed before it had a verdict too, so an error shows in shadow mode, and a broken setup is not hidden.
- `publish` runs `exhibit publish --evidence .exhibit/evidence.json`, where the publish job downloads the artifact. When the check failed before it had a verdict, there is no `evidence.json`, so the publish step fails with exit 2 and posts no comment. The job then shows on the PR as failed, in shadow mode too, and the check job's summary says why.
- Two jobs, by trust. `examples/pull-request.yml` holds them:
  - The check job runs on `pull_request`, never on `pull_request_target`, so code from a PR never runs with a write token. Its only permission is `contents: read`. It checks out the PR with its whole history, so the base and head commits are both in the clone, and runs the Action with `command: check`.
  - The publish job runs after the check job, even when the check step failed in enforce mode, so the comment shows why. Its permissions are `contents: write`, for the data branch, and `pull-requests: write`, for the comment. It checks out the PR's base commit, never its head, downloads the artifact, and runs the released Exhibit with `command: publish`. It runs no script and no code from the PR.
  - For a PR from a fork, GitHub gives a token that cannot write, so the publish job is skipped. A step in the check job says why in the job summary, and the exhibit is still in the artifact.
  - Both jobs use the same released Exhibit, pinned to a release tag or a commit SHA, never `./`, which is the PR's own copy.
- `examples/` holds the workflows that another repo copies. `examples/pull-request.yml` is the one above, with a comment on each permission that says why the job needs it. The README gives the steps to add Exhibit to a repo.
- Exhibit checks its own PRs with `.github/workflows/exhibit.yml`, in shadow mode. It is `examples/pull-request.yml` with three changes: a step that sets up Node 20 for Exhibit's own tests, and a time limit on each job, 30 minutes for the check job and 10 for the publish job. The example has no time limits, because each repo's tests take their own time. It runs the Action from a release tag, the same one the example names, so a PR cannot change the code that the publish job runs with its write token. Exhibit's own `evidence.yml` is the policy for its PRs. `test/action.test.js` reads both workflows, and `test/own-policy.test.js` reads the policy.
- The hidden suite runs only on trusted events.
- **Releases.** `.github/workflows/release.yml` makes a GitHub release when a person pushes a version tag such as `v0.1.0`. Only the person pushes a release tag.
  - It runs on a pushed tag of the form `v1.2.3` only, never on a branch or a PR. Its one job has the permission `contents: write`, to make the release and move the major tag, and nothing more.
  - It fails, and makes no release, when the tagged commit is not on the default branch, or when the tag, the `version` in `package.json` and `exhibit --version` do not all name the same version. `scripts/check-version.js` checks the versions.
  - Then it runs lint and the tests, and installs Exhibit in a clean copy of the tagged commit the way `action.yml` does (`npm ci --omit=dev`), and runs it.
  - It makes the release, with notes that say how to pin it and the list of merged PRs. Then it moves the major tag, such as `v0`, to the release, but only when the release is the newest release of its major version. It counts releases, not tags, so a tag whose run failed does not hold the major tag back. So a repo can pin an exact version or the major tag. The setup notes pin the exact version: the major tag moves, so the check job and the publish job of one run could get different code.
  - `test/release.test.js` reads the workflow and runs the version check.
- Later example workflows in `examples/`:
  - On push to the main branch: run `trace`.
  - Weekly on a schedule: run `history` and `backtest`, then publish the report.

## 11. Technical decisions

| Decision | Reason |
|---|---|
| Node 20 or later, JavaScript ES modules, few runtime dependencies | GitHub Actions run Node natively. The office's main repo is Node. |
| Use the GitHub GraphQL API for history's PR reads, and the REST API for SZZ, both through `fetch`, with the `gh` CLI optional | `fetch` means one less tool to install. One GraphQL query reads 50 merged PRs with their labels, files, reviews, comments and CI results. The REST API needs one request for each PR and each of those lists: about 5 for each PR. SZZ asks about one commit or one issue at a time, so GraphQL saves it little, and its REST replies use the reply cache (section 8.6). |
| Adapters for mutation tools instead of an own engine | Stryker and mutmut are mature. Version 1 does not need its own engine. Exhibit pins Stryker 9.6.1 and its tap test runner as dependencies, because Stryker 10 needs Node 22 and Exhibit runs on Node 20. |
| JUnit XML for test results | Most test runners can write it. |
| Files and a data branch instead of a server or a database | Anyone can run it, and everything stays in their repo. |
| Tests with `node:test`, and recorded API responses as fixtures | No network access in unit tests. |

Every request to the forge goes through one module, `src/github.js` for GitHub, with one named method for each kind of read: `mergedPulls`, `pullFiles`, `pullReviews`, `pullComments`, `pullFileCount`, `ciResults`, `defaultBranch`, `pullsForCommit`, `issue`, and `pull` for `exhibit check --pr`. Each method gives a small forge-neutral shape, not the forge's own objects, so history and SZZ read the same fields from any forge:

- `mergedPulls`, `pullsForCommit` and `pull` give PRs: `number`, `title`, `body`, `author`, `labels`, `mergedAt`, `baseRef`, `baseSha`, `headRef`, `headSha`, `mergeSha` and `url`. An empty body is null. The author is a login, or null for a deleted account. The labels are names. `mergedAt` and `mergeSha` are null for a PR that was not merged.
- `pullFiles` gives each file as `path`, `additions` and `deletions`.
- `pullReviews` gives each review as `state`, `author` and `at`, where `at` is null for a review that is still pending.
- `pullComments` gives each comment as `body`, `author` and `at`.
- `ciResults` gives each CI result as a name, a conclusion and a URL.
- `issue` gives `createdAt` and `isPull`, or null for an issue the forge does not know.
- `pullFileCount` gives a number, and `defaultBranch` a branch name.

On GitHub, the history methods (`mergedPulls`, `pullFiles`, `pullReviews`, `pullComments`, `pullFileCount` and `ciResults`) use the GraphQL API. `mergedPulls` reads 50 merged PRs in one query, each with the first 100 of its labels, files, reviews and comments, its count of changed files, and the first 100 CI results on its last commit (GitHub's status check rollup, which holds the check runs and the commit statuses). The module keeps what it read, so the other methods send a query only for the next page of a list longer than 100, until the list is complete. The GitHub module fills the shapes so that the history file is the same as when it read the REST API: an empty PR body is null, a bot's login ends in `[bot]`, a conclusion is in small letters, and the check runs come newest first, as the REST API lists them. The commit statuses come oldest first, as the REST combined status lists them, by id. The status check rollup lists them A to Z by context instead. On codecov/example-python, 5 of 20 merged PRs had their statuses in another order than REST. GraphQL gives a status no REST id, so the module sorts them by `createdAt`. Two statuses with the same `createdAt` are put in order by the REST id inside their GraphQL node id. A node id such as `SC_kwDOAXN2Ks8AAAAM7nCzPQ` is base64 of a list of three numbers, and the last is the REST id. GitHub does not document this form, so it only breaks a tie, and a node id of another form keeps GitHub's order. Each GraphQL query asks for its own cost, so a run can say how many points it used. GitHub gives a GraphQL rate limit as a 200 reply with an error of the type `RATE_LIMITED`: the client waits on it as on a REST rate limit (section 8.3), and any other error reply makes `exhibit history` exit 2 with GitHub's message. On a large repo, one query for 50 PRs, each with up to 100 files, reviews, comments and CI results, can take longer than GitHub's time limit for one GraphQL query. GitHub then answers 502 or 504. So when the query for the list of merged PRs gets a 502 or a 504, `mergedPulls` asks for the same page again with 25 PRs, and after a second such answer with 10 PRs. It keeps the smaller number for the rest of the list. If the query for 10 PRs gets a 502 or a 504 too, `exhibit history` exits 2 with GitHub's answer. Any other 5xx, such as a 500, makes it exit 2 at once, as before. The SZZ methods (`defaultBranch`, `pullsForCommit` and `issue`) use the REST API. The module also owns the forge's rules. One object, `GITHUB_FORGE`, holds the rules a command needs before it has a forge: the forge's name in a history line's `forge` field (`name`), the forge's name in messages (`displayName`), the check of a repo name (`isRepoName`), the env variable that holds the token (`tokenEnv`), an example of how to set the token (`tokenExample`), and `connect`, which makes the forge. A second forge module gives the same fields. So a command picks the module first and asks it everything. The forge it makes owns the rule for a remote URL that points at the repo (`isRemote`), and names itself by `displayName` in its warnings, such as the warning for a cut-short files list. Every request to Anthropic's API goes through `src/claude.js`, which uses the official `@anthropic-ai/sdk` package. `exhibit label` takes the drafter as a parameter, and its tests replay recorded API replies from `test/fixtures/anthropic/`. History and SZZ take the forge as a parameter, and recorded fixtures sit in one folder for each forge, such as `test/fixtures/github/`. So a second forge, such as GitLab, can come later as a second module with the same methods. Jira sits in a tracker module beside the forge module, `src/jira.js`, in the same way. `JIRA_TRACKER` holds its rules (`name`, `displayName`, the env variables `tokenEnv` and `emailEnv`, and `connect`), and the tracker it makes has the method `ticket(key)`, which gives `{ key, bug, createdAt, escaped }` or null, and `counts()`. It takes the fetch function as a parameter, and its tests replay Jira replies from `test/fixtures/jira/`. So Linear or GitHub issues can come later as a second tracker module with the same methods.

## 12. Field test

Exhibit is built by an office room (Room C), and two other rooms use it on their own repos: the Building58 room on Building58, and Room B on edd-platform.

- **Users install published releases only.** They never run Exhibit from its source. A setup note for each repo gives the workflow to add, a first `evidence.yml` and the token permissions: [Building58](../examples/building58/README.md) and [edd-platform](../examples/edd-platform/README.md). Each note's workflow pins a release, and `test/action.test.js` checks it the same way as `examples/pull-request.yml`. The rooms that own the repos open their own PRs from the notes.
- **Phase A: history.** Run `exhibit history` on Building58 and edd-platform. Bryan labels the escaped defects. The first policy comes from that. The first runs and their numbers are in [field/phase-a-history.md](field/phase-a-history.md).
- **Phase B: shadow mode.** The Action runs on every PR in both repos with `enforce: false`. The session briefs add one step: run `exhibit check` before you open a PR.
- **Phase C: compare.** Room B sets `enforce: true` while Building58 stays in shadow mode. Compare tokens per merged PR, review rounds and stuck runs between the two rooms.
- **Planted faults.** A hidden job opens PRs on a sandbox branch. Each one has a planted bug that the tests miss. They are labeled `exhibit-canary`, closed automatically, and never merged. Exhibit must give `needs_person` on each one.
- **Friction.** When a session fights the tool, it files an issue in the Exhibit repo and attaches the `evidence.json`.
- **Stranger test.** Before version 1.0, a fresh session that has only the README runs `exhibit history` on a public repo it has never seen.

The weekly field log has these numbers:
- Policy misses and false demands.
- The canary catch rate.
- How long `check` takes, at p50 and p90.
- Mutation run time.
- Determinism failures.
- The number of PRs checked.
- From the rooms: tokens per merged PR and review rounds.

## 13. Build order

Each slice is one or more tickets. A slice is done when its checks pass in CI.

| Slice | Scope | Done when |
|---|---|---|
| S1 | `history` export without SZZ | It lists every merged PR on Building58 with files, reviews and CI results. The output passes its schema. Tests use recorded API fixtures. |
| S2 | SZZ and the history report | On a fixture repo with planted bugs and fixes, it finds every link, and it makes no link for whitespace-only lines or for lines moved to another file. |
| S3 | `label` | A person can label all defects from S2. The `--claude` drafts are marked. Agreement with the person is recorded. |
| S4 | Policy and `check` without mutation | It parses and validates `evidence.yml`, classifies the change, and runs tests on the base and head, the failing-before check and probes. It gives the verdict and the exit codes. The same commit checked twice gives the same `evidence.json`, apart from timings. |
| S5 | The GitHub Action, shadow mode, the data branch, the PR comment | It runs on every PR in Building58 and edd-platform in shadow mode. |
| S6 | Mutation adapters | Stryker first, then mutmut. Only the changed lines are mutated. The budget and the interval work. The Stryker adapter is built (ticket 260). mutmut and marking a mutant as equivalent are still to do. |
| S7 | `trace` and policy misses | A fix merge records its policy misses on the data branch. |
| S8 | `backtest` and the trust ladder numbers | The leak check works. The report gives counts and intervals for each kind of change. |
| S9 | The canary job, the field log, the stranger test | Then release version 1.0. |

## 14. What success looks like for version 1.0

- On Building58 and edd-platform, the backtest catches most escaped defects with a false-demand rate that the maintainer accepts. Bryan sets the two targets after S2, when the baseline is known.
- The canary catch rate is 90% or higher.
- `check` never gives `meets_policy` after a tool error. A test proves this.
- A stranger gets a history report on a new repo within 10 minutes of opening the README.

## 15. Risks

| Risk | What Exhibit does about it |
|---|---|
| SZZ makes false links from refactors, moved code and whitespace. | It shows each link with its evidence, and the person can reject it. |
| Bugs nobody noticed are not in the history. | The blind sample is the defense. |
| A small history gives wide intervals. | Every number comes with its interval and its n. |
| Mutation testing is slow. | It runs on the changed lines only, under a time budget. |
| A policy learned in one repo may not fit another. | There is one policy per repo, and two field-test repos from the start. |
| One model writes the code and the fixes. | Hidden checks and the blind sample are the defense. |
| The builder edits the policy to pass its own PR. | `exhibit check` reads the policy from the base commit, never from the PR's changes or the files on disk (section 8.1), so a change cannot change the rules that check it. A change to the policy file also always gives `needs_person`, and the maintainer reviews it. Claude Code's review does the same with its rules file: it reads it "from the base or default branch, never from the pull request's changes" ([How the Claude Code team thinks about verification](https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification/), section 17.2). |

## 16. Open questions

1. The package name. `exhibit` may be taken on npm. A scoped name such as `@bfalkowski/exhibit` is the fallback.
2. The license: decided. Exhibit uses the MIT license (the `LICENSE` file), so anyone may use, change and share it.
3. Where the hidden suite lives, and how CI gets access to it.
4. How to detect fix PRs in repos that use no labels. Section 17.3 lists one lead: an oracle built from fixes that name the change that added the bug. Reverts are a second lead: a revert names the PR it takes back, so the `revert` signal (section 9.1) finds escaped defects that are sure, with no label and no blame guess (section 9.2). It is not in the defaults yet. A field run should first show how often a revert is not a bug. A repo that tracks bugs in Jira can use the `tracker:jira` signal (ticket 104, section 9.1), which asks Jira whether the PR's ticket is a bug. Other trackers, such as Linear or GitHub issues, are still open.
5. Whether to sign `evidence.json`, for example with Sigstore, so a session cannot forge it.
6. Whether to add "cost of the next change" (tokens and review rounds per ticket, by area) as a measure of code quality later.
7. Whether workflow artifacts are enough for storage, given their retention limit, or whether the data branch is always needed.
8. Whether SZZ in S2 needs the real merge-base of each PR. Answered in part: a history line now has `head_sha` (ticket 78), so `git merge-base` can be computed from the line alone, with no new request to the forge (section 8.3). What is left is whether SZZ should use the merge-base. `base_sha` is the tip of the base branch, not the merge-base. Today SZZ does not need either: it blames the main branch just before the fix (section 9.2, step 3).

## 17. Related work

The search for this section was done on 2026-11-19. It was not complete. Vendor tools and patents may hold more.

No work found so far does the whole loop: learn a policy from one repo's escaped defects, check each PR against it with a measure of how strong the tests are, test the policy on history, and give the numbers for a rung. Each part has prior work. This section lists it, so that Exhibit can reuse what is known and cite it.

### 17.1 Closest in goal

| Work | What it does | How Exhibit is different |
|---|---|---|
| [RADAR](https://arxiv.org/abs/2605.30208), Meta, 2026 | Decides which diffs can land with no human review. Its stages are eligibility rules, static heuristics, a learned Diff Risk Score, an LLM review agent and deterministic checks. It reports 331,720 diffs landed out of 535,290, with about 1/3 of the revert rate and 1/50 of the incident rate of other diffs. RADAR picks low-risk diffs, so these rates compare unlike groups. | RADAR scores risk with a model and an LLM. Exhibit asks for evidence for each kind of change, from rules learned from the repo's own escaped defects. The RADAR paper describes no measure of test strength and no random sample of the diffs that landed. |
| [ARCTIC](https://arxiv.org/abs/2607.29516), Meta, 2026 | Predicts what a diff is meant to do, measures how far the code drifts from that, and points to the code that most needs review. When drift is low and nothing is flagged, the author can confirm the diff and land it on a faster path. | ARCTIC helps a person review less. Exhibit decides, for one kind of change at a time, when nobody needs to read the code. |
| [Diff risk scoring](https://arxiv.org/abs/2410.06351), Meta, ICSE 2025 | Scores each diff for the risk that it causes an incident, and holds back the riskiest diffs during code freezes. | A risk score says which PRs to look at. Exhibit says what evidence a PR must show. A risk score could be a later input when Exhibit classifies a change. |

### 17.2 Write-ups from practice

| Work | What it says | How Exhibit is different |
|---|---|---|
| [Reading evidence instead of code](https://developertoolkit.ai/en/ladder/evidence-not-diffs/), Autonomy Ladder guide, 2026 | Read four things in place of the diff: the spec delta, the acceptance results, oracle strength and runtime signals. Run mutation testing on changed files with Stryker or mutmut. Ask whether the decisive check existed before the change. Keep a trust log that moves classes of change up or down. | The ideas are very close to Exhibit's. The guide gives them as prompts and a log kept by hand. Exhibit makes them a CLI with a policy file, a backtest and numbers. |
| [Make Every PR Prove Itself](https://builders.abnormal.ai/p/make-every-pr-prove-itself), Abnormal, 2026 | Each agent PR shows evidence from a near-production test environment, such as real API responses and screenshots. Misses that become incidents are written back into the checks. | Reviewers still review each PR. The checks are not measured. |
| [How the Claude Code team thinks about verification](https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification/), Anthropic, 2026 | Measures bug finders on real changes. When the team reviews its reviewers, it tracks how they do on "a size-matched subset of changes that have stayed clean". It replays bug finders on PRs tied to known incidents. It measures "the recall rate for raw findings, post-verification, and final review separately", so a bug that is found and then lost shows up. It tidies checks on a routine, because they "only grow if you let them". | Backtest takes four measures from it (section 9.9): false demands on size-matched clean PRs, each defect replayed at its introducing PR, the funnel, and rules that do not pay. Exhibit learns its rules from SZZ-traced defects, and a person removes a rule, never Exhibit. |
| Lauren Tan's trust ladder, in [a talk with Matt Pocock](https://www.youtube.com/watch?v=MN9dGgmLyso) | Give agents more as verification earns trust. Near the top, agents merge their own PRs and a person samples them after they land. | Exhibit gives the numbers for each step, for one kind of change at a time. |

### 17.3 Prior work for each part

| Part of Exhibit | Prior work | What Exhibit can take from it |
|---|---|---|
| SZZ (section 9.2) | [Śliwerski, Zimmermann and Zeller](https://www.st.cs.uni-saarland.de/papers/msr2005/), MSR 2005 | The method. |
| How accurate SZZ is | [Rosa et al.](https://arxiv.org/abs/2102.03300), ICSE 2021: an oracle built from fix commits whose message names the commit that added the bug | A way to test SZZ links. The same idea may help with open question 4, because a ticket in the office can name the PR that a bug came from. |
| What wrong SZZ links do | [Fan et al.](https://ink.library.smu.edu.sg/sis_research/4494), TSE 2019: changes that SZZ labels wrongly change the results of just-in-time defect prediction | Wrong links change the results that come after them. This is why a person can reject a link in `exhibit label`. |
| Risk of a change | [Kamei et al.](https://sail.cs.queensu.ca/data/pdfs/TSE_ALarge-ScaleEmpiricalStudyOfJust-in-TimeQualityAssurance.pdf), TSE 2013: just-in-time defect prediction | Predicts risky changes from change metrics. A possible later input when Exhibit classifies a change. |
| Mutation on changed lines (section 9.5) | [State of Mutation Testing at Google](https://research.google/pubs/state-of-mutation-testing-at-google/), ICSE SEIP 2018, and [Practical Mutation Testing at Scale](https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/), TSE 2021 | Google mutates only changed code during code review. It removes mutants that are likely to be irrelevant, and limits the mutants for each line and each review. Exhibit can copy these filters. |
| Whether mutants point to real bugs | [Does mutation testing improve testing practices?](https://arxiv.org/abs/2103.07189), Google, 2021, and [Just et al.](https://homes.cs.washington.edu/~mernst/pubs/mutation-effectiveness-fse2014-abstract.html), FSE 2014 | The Google study found that, for changes that added bugs, mutation testing would have shown a surviving mutant that could have stopped the bug. This supports the catch rate as evidence. |
| Closing a gap that mutation finds | [ACH](https://arxiv.org/abs/2501.12862), Meta, FSE 2025: an LLM plants faults for a named concern and writes tests that catch them | A possible later step: when mutants survive, draft a test that catches them. |
| A test that failed before (section 9.4) | [SWT-Bench](https://arxiv.org/abs/2406.12952), NeurIPS 2024: a test counts when it fails before the fix and passes after it | The same check. Fixes that passed such tests more than doubled SWE-Agent's precision. |
| Error analysis (`exhibit label`) | [Orthogonal Defect Classification](https://www.chillarege.com/node/23), IBM, TSE 1992: put defects into classes, and use what triggered each defect to measure how well inspection or testing works | An old, tested way to turn defect codes into a measure of the checks. |
| Rule of three (section 9.10) | [Hanley and Lippman-Hand](https://doi.org/10.1001/jama.1983.03330370053031), JAMA 1983 | The source of the 3/n bound. |
| Stranger test (section 12) | [AIDev](https://arxiv.org/abs/2507.15003), 2025: over 456,000 PRs by five coding agents, Claude Code among them | Public repos with many agent PRs, to run `exhibit history` on. |

### 17.4 Scale and stakes

The field test is small, and the cost of a miss is low. Building58 and edd-platform are personal projects with one maintainer and no other users. When a bug reaches main, the maintainer files a ticket. Nobody is paged at night, and no customer sees an outage. RADAR's numbers come from production systems, where a miss can be an incident.

The escaped defects are also only the bugs that a session or the maintainer noticed. No production monitoring finds the others.

So a rung that Exhibit's numbers support here says little about a repo where a miss costs more. A team with real users needs more PRs for each kind of change, a smaller miss bound before rung 3, and outcomes such as reverts and incidents next to the policy misses.
