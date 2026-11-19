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
| Introducing PR | The PR that added the lines a fix changed. |
| Policy miss | An escaped defect whose introducing PR got `meets_policy`. |
| False demand | A requirement that was missing on a PR that turned out to be fine. |
| Catch rate | Killed mutants divided by killed plus survived mutants, on the changed lines. |
| Shadow mode | Exhibit gives its verdict, but nothing waits on it. |
| Blind sample | Merged PRs picked at random that a person reads without seeing the verdict first. |
| Rung | One step on the trust ladder, for one kind of change. Only a person turns a rung on. |
| Forge | The service that hosts the repo and its PRs, such as GitHub. |
| Reply cache | The folder where Exhibit saves GitHub replies with their ETags, so a later run can get a 304 instead of a full reply (section 8.6). |

## 7. Commands

All commands accept `--json` for machine output and `--repo owner/name`. Each command exits 0 on success and 2 on a tool error.

| Command | What it does |
|---|---|
| `exhibit init` | Writes a starter `evidence.yml` and example workflow files. |
| `exhibit history [--since DATE] [--limit N] [--full] [--no-cache]` | Exports merged PRs to `.exhibit/history.jsonl`, runs SZZ, and writes a report. When the file is there, it reads only what is new (section 8.3). `--full` reads every PR again. `--no-cache` turns off the reply cache (section 8.6). |
| `exhibit label [--claude]` | Shows each escaped defect that has no code yet. With `--claude`, Claude drafts a code and a category. The person confirms or edits each one. Writes `.exhibit/labels.jsonl`. |
| `exhibit policy suggest` | Drafts policy rules from the labeled categories and prints them as a diff to `evidence.yml`. It never writes the file itself. |
| `exhibit backtest [--from DATE] [--rerun]` | Applies the policy to PRs merged after a date and reports caught, missed and false demands for each kind of change. |
| `exhibit check [--base REF] [--head REF] [--pr N]` | Works out what the PR needs, collects the evidence, and writes `evidence.json` and `summary.md`. Exits 0 for `meets_policy` and 1 for `needs_person`. |
| `exhibit verify FILE` | Runs the claims in an `evidence.json` again and reports any that do not hold. |
| `exhibit trace --pr N` | Runs after a merge. If the PR is a fix, it finds the introducing PRs and records any policy miss. |

## 8. Files and formats

### 8.1 `evidence.yml`

```yaml
version: 3
settings:
  test_command: "npm test -- --test-reporter=junit --test-reporter-destination=.exhibit/junit.xml"
  test_results: ".exhibit/junit.xml"
  fix_signals: [label:bug, title:fix, branch:fix/]
  mutation_budget_seconds: 300
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
- Exhibit validates the file against a JSON schema and refuses to run on an invalid policy.

Evidence item types in version 1:

| Type | Met when |
|---|---|
| `tests-before-after` | The test command ran on the base and on the head, and every test passes on the head, except tests marked flaky (section 9.3). |
| `failing-before` | At least one test that the PR added or changed fails on the base and passes on the head. `when` limits it to PRs classified as fix or feature. |
| `mutation` | The catch rate on the changed lines is at least `min`. |
| `probe` | A named command exits 0 on the head and writes its declared artifacts. Screenshots, restart runs, link checks, contract tests and hidden suites are all probes. |

A probe can set `author: hidden`. Exhibit then counts it as a check the builder cannot see.

### 8.2 `evidence.json`

```json
{
  "exhibit_version": "0.1.0",
  "policy": { "path": "evidence.yml", "sha256": "..." },
  "repo": "owner/name",
  "pr": 112,
  "base": "sha",
  "head": "sha",
  "classification": { "kinds": ["relay-core"], "risk": "high", "fix": true },
  "requirements": [
    {
      "type": "mutation",
      "params": { "min": 0.85 },
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

`status` is one of `met`, `missing`, `failed`, `skipped` or `error`. An `error` on any requirement makes the verdict `error`, never `meets_policy`.

### 8.3 `.exhibit/history.jsonl`

One merged PR per line, with these fields:

- `number`, `title`, `body`, `author`, `labels`, `merged_at`, `base_ref`, `base_sha`, `head_sha`, `merge_sha`
- `forge`: the forge the PR came from, and `url`: the PR's web page on that forge
- `files`: path, additions and deletions for each file
- `classification`: `fix` is true when the PR is a fix, and `fix_signal` names the signal that matched. `fix_signal` is null when no signal matched. From S4, `kinds` will hold the kinds of change under the current policy. Today `classification` has no `kinds` field (see "Later slices" below).
- `reviews`: `list` holds the `state`, `author` and `source` of each review, oldest first. `source` is `review` for a GitHub review, or `comment` for a review posted as a PR comment. `change_request_rounds` is the number of reviews with the state `CHANGES_REQUESTED`, from both sources.
- `ci`: the `name` and `conclusion` of each check run on the PR's last head commit, then of each commit status on it. For a commit status, `name` is its context and `conclusion` is its state. A reader of `ci`, such as the S5 backtest, must allow for two things: an app that posts both a check run and a commit status with the same name shows up twice, and a commit status can give the conclusion `error`, which a check run never gives.
- `evidence_section`: the evidence the PR body claims, if the repo uses such a section
- `szz`: for fix PRs, the introducing PRs, the lines, the blame output for each line, and a confidence score
- `exhibit`: the verdict and the requirements, if an exhibit exists for this PR

The schema for one line is `schema/history-line.schema.json`. `exhibit history` checks every line against it before it writes the file. If a line fails, it writes nothing and exits 2.

What each version fills:

- **S1, first half:** `number`, `title`, `body`, `author`, `labels`, `merged_at`, `base_ref`, `base_sha`, `merge_sha` and `files`. `body` is null when the PR has no description. `author` is null when the account was deleted. Lines are in merge order, newest first. GitHub lists at most 3,000 files for one PR, so `files` for a larger PR is cut short. When that happens, `exhibit history` prints a warning on stderr that names the PR and both counts, and still exits 0. GitHub gives each PR's count of changed files in the same GraphQL query as the PR (section 11), so the count costs no request. That count is only for the warning. So when a forge cannot give it, `exhibit history` does not fail: it warns that the PR's `files` may be cut short and that the count is unknown, and goes on. `number` is the PR number that people see on the forge. `base_ref` is the branch the PR was merged into. `base_sha` is the tip of the base branch when the PR was last updated. It is not always the merge-base of the PR. `merge_sha` is the commit the merge put on the base branch: a merge commit, a squash commit, or the last copy of a "rebase and merge". The schema requires `base_ref`. A history file from before PR 58 has no `base_ref`, so it fails the schema. Run `exhibit history` again: it writes the whole file new, so the new file has `base_ref` on every line.
- **S1, second half:** `reviews` and `ci`. The schema requires both. A PR with no reviews has `{"change_request_rounds": 0, "list": []}`. A change request that was later dismissed has the state `DISMISSED`, so it is not a round. A review `author` is null when the account was deleted. A PR with no check runs and no commit statuses has an empty `ci` list. A check run that has not finished has a null `conclusion`. Some CI services post commit statuses instead of check runs, so `ci` holds both: check runs first, then commit statuses. For commit statuses, GitHub gives only the newest status for each context. A status `conclusion` is `success`, `failure` or `error`, and a `pending` status has a null `conclusion`, the same as a check run that has not finished.
- **Reviews posted as PR comments:** some rooms post each review as a PR comment, not as a GitHub review. On Building58 no merged PR has a GitHub review. So `exhibit history` also reads the PR's comments, and a comment that gives a verdict is a review with the `source` `comment`:
  - A verdict is the word `verdict`, then `merge` or `fix`, as in `Verdict: fix` or `**Verdict:** merge`. A colon, spaces, `*`, `_`, backticks and equals signs may come between them, as in ``Verdict: `merge` `` or `Verdict = fix`. A hyphen may come between them too, as in `Verdict - fix`, but only when the phrase starts the line, after any spaces, `>`, `#`, `*` or `_`, and after a list marker such as `-`, `+`, `*`, `1.` or `1)`. So `- Verdict - fix` and `1. Verdict - merge` count. In prose a hyphen is often a dash, so `The verdict - merge - waits on CI.` is not a verdict, and neither is `## Code review of b8ebe79 - merge`, where other words come before the phrase. A review heading with the verdict after the commit is a verdict too, as in `## Review of b8ebe79: merge`. Case does not matter.
  - A line that starts with `>`, after any spaces, is a markdown quote of another comment, so its verdict does not count. A reply that quotes `> Verdict: fix` and then says `Fixed in abc1234` is not a review. A line right after a quote line is in the quote too, as markdown shows it, until a blank line, a heading, a code fence, a list item or a thematic break (`---`) ends the quote. Only plain text goes on a quote this way. Two kinds of line are not quotes:
    - A line in a code fence (```` ``` ```` or `~~~`), even when it starts with `>`.
    - A line of a GitHub alert box, such as `> [!IMPORTANT]` then `> Verdict: fix`. An alert box is the comment's own text, so its verdict counts. A quote nested in an alert box, as in `> > Verdict: fix`, is still a quote. The alert kinds are `NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`.
  - When a comment gives a verdict only in quoted lines, `exhibit history` does not count it, and prints a warning on stderr that names the PR, the comment's author and time, and the verdict. Most such comments are replies, but the warning lets a person find a review that quoted its own verdict.
  - The first verdict in the comment counts. `fix` gives the state `CHANGES_REQUESTED`, so it is a round. `merge` gives the state `APPROVED`.
  - A comment that starts with an `<!-- office:` marker, such as `<!-- office:dev -->`, is a room note or a Dev's reply, not a review, even when it repeats the verdict.
  - A comment with no verdict is not a review, and is not in `reviews`.
  - The comment reviews and the GitHub reviews are merged into one list by time: `created_at` for a comment, `submitted_at` for a review. At the same time, the review comes first. A pending review has no `submitted_at`, so it comes before every comment that is still left, even an older one.
- **Head commit, forge and web page (ticket 78):** every line has `head_sha`, `forge` and `url`, and the schema requires all three.
  - `head_sha` is the PR's last head commit: the last commit on the PR's branch. It is not the merge commit. For a squash merge, `merge_sha` is a new commit that is not on the PR's branch at all. With `head_sha`, `git merge-base` can find where the PR's branch left the base branch from the line alone, for example `git merge-base <head_sha> <merge_sha>^1`. This needs the head commit in the clone. GitHub keeps it at `refs/pull/<number>/head` after the branch is deleted, but a plain clone does not fetch those refs, so fetch them first, for example with `git fetch origin '+refs/pull/*/head:refs/pull/*/head'`.
  - `forge` names the forge the PR came from. Today it is always `github`. The schema allows only the forges Exhibit knows, so a new forge adds its name there.
  - `url` is the PR's web page on the forge, such as `https://github.com/bfalkowski/Building58/pull/82`.
  - A history file from before ticket 78 has no `head_sha`, `forge` or `url`, so it fails the schema. Run `exhibit history` again: it writes the whole file new, so the new file has the three fields on every line.
- **S2, fix signals:** `classification` holds two fields. `fix` is true when any fix signal matches (section 9.1). `fix_signal` is the first signal in the list that matched, such as `label:bug`, so a person can see why the PR counts as a fix. It is null when no signal matched. Every line has `classification`. A history file from before S2 has no `classification`, so it fails the schema. Run `exhibit history` again: it writes the whole file new, so the new file has `classification` on every line.
- **S2, SZZ:** every line has `szz` (section 9.2), and the schema requires it. A history file written before `szz` was added has no `szz`, so it fails the schema, even when it has `classification`. Run `exhibit history` again: it writes the whole file new, so the new file has `szz` on every line. `szz` is null when the PR is not a fix, or when SZZ did not run. Otherwise it holds five fields:
  - `blamed_commit`: the commit that `git blame` ran on: the parent of the fix's first commit on the main branch (section 9.2, step 3).
  - `links`: one for each introducing PR, highest confidence first. A link has `pr`, `confidence` and `lines`.
  - `unlinked_lines`: the lines whose commit is in no merged PR, such as a commit pushed straight to the main branch.
  - `dropped_lines`: the lines that SZZ does not count, because they carry no bug (section 9.2, steps 2 and 5). Each has `path`, `line`, `text` and `reason`. The `reason` is `whitespace`, `comment`, `moved` or `newer than the bug report`.
  - `no_link_reason`: why the fix has no links, when SZZ dropped every line it deleted or changed. It names the reasons, in the order whitespace, comments, moved lines, lines newer than the bug report, and ends with "only": for example "whitespace only", "moved lines only" or "whitespace and comments only". It is null when some lines are left, or when the fix deleted or changed no lines.

  Each line in `links` and `unlinked_lines` has `path`, `line` (its number in `blamed_commit`), `text`, and `blame`. `blame` holds what `git blame` says about the line: `commit`, `original_path`, `original_line`, `author`, `author_time` (UTC) and `summary` (the first line of the commit message).

  A history file from before ticket 8 has no `dropped_lines` or `no_link_reason`, so it fails the schema. Run `exhibit history` again: it writes the whole file new.
- **Incremental runs (ticket 94):** a merged PR almost never changes, so a run that finds `.exhibit/history.jsonl` from an earlier run reads only what is new:
  - It always reads GitHub's whole list of merged PRs. That costs one GraphQL query for each 50 merged PRs, and the query also reads each PR's lists (section 11). `--since` and `--limit` pick from this list as they do on a first run, so the new file holds the same PRs that a first run with the same options would write. A line for a PR they leave out is dropped.
  - A PR that has no line in the old file is read in full: its files, reviews, comments and CI results. So a PR merged after the last run gets a new line. So does an older PR that an earlier `--since` or `--limit` left out.
  - The look-back window is the 7 days before the newest `merged_at` in the old file. A PR merged in that window, at its start time or later, is read again, and its new line replaces the old one. So a late review, a late review comment, or a CI result that finished after the last run shows up. A late review on a PR merged before the window does not show up: run with `--full` for that.
  - Every other line is kept as it is, and no request asks about its PR.
  - SZZ runs on a fix PR that was read, unless the old file already had it as a fix with a `szz` that is not null: then it keeps that `szz`, because the PR's code does not change after its merge. A fix whose `szz` was null, because SZZ skipped it, gets SZZ again. The map from a commit to its PR still sees every line in the file, kept lines too.
  - The file stays in merge order, newest first.
  - `--full` reads every PR again and writes the whole file new. Run it after you change `fix_signals` in `evidence.yml`, because a kept line keeps its old `classification`.
  - A run reads every PR again by itself, and prints one note on stderr that says why, when the old file has a line that is not JSON, a line that does not fit the schema (as in a file from an older version of Exhibit), or a line from another repo or forge.
  - Every run prints how many PRs it read from GitHub, how many GitHub REST requests it made, and how many GraphQL queries it made and how many points they used (section 8.6). With `--json`, the summary has `read`, and `mode`: `full` for a run that read every PR, or `incremental`.
  - The query for the list of merged PRs also reads the first page of each PR's labels, files, reviews, comments and CI results, for every merged PR, also the ones the run keeps. So an incremental run sends the same queries for the list as a full run. It sends fewer queries only for PRs with lists longer than one page. An incremental run still saves the SZZ requests of the kept lines.
- **Later slices:** `evidence_section` and `exhibit` are filled by later slices. Until then they are absent, and the schema allows them only as null. The kinds of change come in slice S4. Until then `classification` has no `kinds` field, not even as null: the schema refuses any field in `classification` other than `fix` and `fix_signal`. S4 must add `kinds` to `classification` in the schema and update this section.

When GitHub says to wait, `exhibit history` waits and asks again, at most three times. GitHub says to wait with a 429 or 403 reply, or, for a GraphQL query, with a 200 reply that holds an error of the type `RATE_LIMITED`, in one of three ways:

- A `retry-after` header. It holds whole seconds, or an HTTP date such as `Thu, 19 Nov 2026 10:00:30 GMT`, and `exhibit history` waits that long or until that time. A value in any other form, such as `1.5`, counts as no `retry-after` header.
- No requests left until `x-ratelimit-reset`. `exhibit history` waits until one second after that time.
- A message that names a secondary rate limit, with neither of these headers. GitHub's docs say to wait at least one minute, and longer each time the limit comes back. So the first wait for a secondary limit is one minute, the second two minutes, and the third four minutes. Waits of the other two kinds do not count here. Each wait gets a random extra of up to a quarter of it, so the requests that hit the limit together do not all ask again at the same moment. The longest such wait is five minutes.

If GitHub asks for a wait longer than 15 minutes, it stops and exits 2. After three waits it stops and exits 2 too.

`exhibit history` reads `GITHUB_TOKEN`. A fine-grained token needs these repository permissions:

- Metadata: read. GitHub gives it to every fine-grained token.
- Pull requests: read, for the PRs, their files, reviews and comments, and for the PRs of a commit (SZZ).
- Checks: read, for the check runs. GitHub's page of permissions for fine-grained tokens does not list the check-runs request, so this one is not yet confirmed.
- Commit statuses: read, for the commit statuses.

A classic token needs the `repo` scope for a private repo, and no scope for a public one. When a request gets a 403 that is not a rate limit, the message names the permission that request needs, so a person can see which one the token lacks. A 429, and a rate limit that is still there when the waits end, do not name a permission.

### 8.4 `.exhibit/labels.jsonl`

One escaped defect per line, with these fields:

- `id`, such as `D-004`
- `fix_pr`, `introducing_prs`
- `code`: a short description of what went wrong
- `category`
- `would_have_caught`: the evidence that would have caught it
- `labeled_by`: `person`, or `claude_draft_confirmed`, or `claude_draft_edited`
- `szz_link_rejected`: true if the person rejected the link
- `labeled_at`

### 8.5 Report

`exhibit history` and `exhibit backtest` write `report.md` and a self-contained `report.html`. The first screen of the report shows:
- The number of PRs read and the number of fix PRs.
- The escaped defects found, each with its SZZ evidence.
- How sure Exhibit is, in plain words. With weak history, the report says so instead of guessing.

`exhibit history` writes the report to `.exhibit/report.md` and `.exhibit/report.html`, together with `.exhibit/history.jsonl`. It writes all three to temporary files first, and renames them only when every write worked. So a run that fails, for example on a full disk, changes none of the three files, and they keep the same facts. Both files come from the same content, so they hold the same facts. `--json` names the two files in its `report` field. `exhibit backtest` must not write to these two paths, or it would write over the history report. Its report paths are not set yet: S8 sets them. The report has these parts, in this order:

1. **The counts.** The number of merged PRs read, the number of fix PRs, and how many of the fix PRs SZZ linked to an introducing PR. Each fix PR with at least one link is an escaped defect. When SZZ skipped a fix PR (section 9.2), the count says so. With no fix PRs, the report says so in one sentence and has no list of defects. Outside a clone, SZZ did not run, and the report says it cannot show escaped defects.
2. **How sure Exhibit is.** Whether the history is weak, and why, in plain words, then the rule below.
3. **The escaped defects**, newest fix first. For each one: the fix PR and its title, the commit that SZZ blamed, and each introducing PR with its confidence as a percent and as a count of the fix's counted lines. Under each introducing PR are its lines (path, line number and text) and what `git blame` said about each one: the commit, the author, the date and the commit summary, and the first path and line when they differ. The lines that came from no merged PR are listed too. The report shows at most 5 lines for each link, then says how many more there are. `history.jsonl` has them all.
4. **The fix PRs with no escaped defect found**, and why: SZZ skipped the PR, dropped every line (the `no_link_reason`), found its lines only in commits that are in no merged PR, or found no deleted or changed line to blame.

**Weak history.** The history is weak when one of these is true:

- It has fewer than 10 fix PRs. With 9 it is weak, and with 10 it is not.
- SZZ linked none of the fix PRs, or did not run.
- Fewer than half of the escaped defects have a strong link. A strong link has a confidence of 0.5 or more. So 2 strong defects of 4 is not weak, and 1 of 4 is weak.

Each link counts lines, not bugs, so with few fixes, or with links that hold only a small part of a fix's lines, Exhibit cannot tell a real pattern from chance. A weak history makes the report say "The history is weak" and list the reasons. With no fix PRs, the report also says to check that the fix signals match how the repo marks a fix, and names them.

`report.html` works with no network. Its styles are in the file. It has no scripts, no images, no links, and a Content Security Policy of `default-src 'none'; style-src 'unsafe-inline'`, so a browser loads nothing from outside the file. It escapes all text from the history, so a PR title cannot add HTML. `report.md` escapes markdown marks in that text, so a title is shown as it is.

### 8.6 Reply cache

GitHub allows a token 5,000 REST requests an hour, and every run with that token shares the limit. A conditional request costs nothing when nothing changed: GitHub answers `304 Not Modified`, and a 304 does not count against the rate limit. So `exhibit history` saves GitHub replies in a reply cache, and asks again with `If-None-Match`.

- **The folder.** All runs by one user on a machine share one folder: `exhibit/github` in the user's cache folder. That is `$XDG_CACHE_HOME/exhibit/github` when `XDG_CACHE_HOME` is set. Otherwise it is `~/Library/Caches/exhibit/github` on macOS, `%LOCALAPPDATA%\exhibit\github` on Windows, and `~/.cache/exhibit/github` elsewhere. The first write of a run makes the folder if it is not there, and sets its mode to 700, because it can hold replies about private repos. Each file has mode 600.
- **An entry.** Each entry is one JSON file that holds the URL, the ETag, the body of the reply, and its `content-type` and `link` headers. The client reads the next page from `link`. Only a 200 reply with an ETag is saved. A newer 200 for the same URL replaces the entry.
- **The key.** The file name is a SHA-256 hash of the URL and a SHA-256 hash of the token. So two tokens never share an entry, even for the same URL, and a token with less access never gets a reply that another token read. No file name or file holds the token.
- **A request.** When the URL has an entry, the request sends its ETag in `If-None-Match`. A 304 gives the saved body. Any other reply is used as before, and a 200 with an ETag replaces the entry.
- **A full last page.** GitHub's ETag covers the body only, not the `link` header. When a list's last page is full and a new item comes, the item goes on a new page. The full page does not change, so it gets a 304, and its saved `link` names no next page. So when a page of a list comes from the cache, is full (it has as many items as `per_page`, or 30 when the URL names none), and its saved `link` names no next page, the client asks for it again with no `If-None-Match`. That costs one more request, and the new reply replaces the entry. A page that is not full is the last page, so its 304 is trusted.
- **A broken entry.** An entry that is not valid JSON, is cut short, or lacks a field counts as no entry: the request goes without `If-None-Match`, and the new reply replaces it. A write first goes to a temporary file that is then renamed, so another run never reads half an entry. A write that fails is ignored. The cache never stops a run.
- **`--no-cache`.** The run reads no entry, sends no `If-None-Match`, and writes nothing to the folder.
- **GraphQL.** History reads the PRs with GitHub's GraphQL API (section 11). A GraphQL query is a POST request, and GitHub gives it no ETag, so the cache does not hold GraphQL replies. Today only SZZ's REST requests use the cache.
- **The counts.** At the end, `exhibit history` prints how many REST requests went to GitHub and how many got a 304, then how many GraphQL queries went and how many points they used, for example `Made 6 GitHub REST requests. 6 got a 304 and came from the cache in /Users/me/Library/Caches/exhibit/github.` and `Made 3 GitHub GraphQL queries, which used 3 points of the GraphQL rate limit.` With `--no-cache` the second sentence is `The cache was off.` `--json` gives the same in its `github` field: `{ "requests": 6, "not_modified": 6, "cache": "<folder>", "graphql": { "queries": 3, "points": 3 } }`, with `cache` null under `--no-cache`. The points are the `cost` that GitHub gives for each query. A request or query that is asked again after a rate-limit wait, or a request asked again after a full last page from the cache, counts each time. A request that never reached GitHub, such as one with no network, does not count. A run that fails prints the counts on stderr before it exits 2.

The cache does not remove old entries. Deleting the folder is always safe: the next run fills it again.

## 9. How the parts work

### 9.1 Classifying a change

- Kinds are matched by globs on the changed file paths.
- A PR counts as a fix when any signal in `fix_signals` matches. A signal is a type and a value, with a colon between them:
  - `label:bug` matches a label named `bug`. The whole name must match.
  - `title:fix` matches a title that starts with the word `fix`. It matches "fix: crash", "Fix the crash" and "fix(cli): crash". It does not match "Fixture for tests" or "Add prefix fixer", because a prefix is not "contains", and the word must end where the prefix ends.
  - `title_after_key:fix` works like `title:fix`, but first skips a ticket key at the start of the title. Many teams start a title with a key, such as "T-170: Fix the crash", so `title:fix` never matches them. A key is letters and digits, a hyphen, and digits, such as `T-170` or `KEY-123`. It may be in square brackets or parentheses, and a colon or a space follows it. So `title_after_key:fix` matches "T-170: Fix the crash", "KEY-123: fix the parser" and "[KEY-123] fix the parser". It does not match "T-170: Add prefix fixer" or "T-170: Improve fixtures", by the same word rule as `title:`. A title with no key matches the same way as with `title:fix`. A number alone, such as "79:", is not a key. This type is not in the defaults: a person adds it to `fix_signals`, for example `[label:bug, title_after_key:fix, branch:fix/]`.
  - `branch:fix/` matches a head branch whose name starts with `fix/`.
  - All matching ignores case.
- The signals come from `settings.fix_signals` in `evidence.yml`. With no `evidence.yml`, or no `settings.fix_signals` in it, Exhibit uses `[label:bug, title:fix, branch:fix/]`. A custom list replaces these defaults. `exhibit history` reads only this one setting from the file, and the other settings are not checked until slice S4.
- A `fix_signals` that is not a list, is empty, has a signal that does not start with `label:`, `title:`, `title_after_key:` or `branch:`, or has a space before or after the value (such as "label: bug") makes `exhibit history` exit 2 with a message. A file that is not valid YAML does too.
- A linked issue with a bug label is a later signal type. The REST API does not give linked issues directly.
- A PR counts as a feature when it adds files under a path the policy marks as source, or when a `feature` label is set.

### 9.2 SZZ

`exhibit history` runs SZZ only when it runs inside a clone of the repo: a git repo with a remote that points at the repo on GitHub, in any URL form. Otherwise it writes `szz: null` on every line and says so in one line on stderr. The run still succeeds.

1. For each fix PR, take the lines it deleted or changed. These are the old lines in `git diff -U0 -M` from the main branch just before the fix (step 3 says which commit that is) to `merge_sha`. A renamed file keeps its old path. A line the fix only added has nothing to blame.
2. Drop the lines that carry no bug. Each added line in the diff can explain one dropped line at most. A hunk shows only the changed lines, so Exhibit also reads each changed JavaScript, TypeScript and Python file whole, at the commit that blame runs on (step 3) and at `merge_sha`, in one `git cat-file --batch` call. The file says what the hunk cannot: whether a line starts inside a block comment, and how deep a Python line's block is. When git cannot read a file, the rules guess from the hunk alone, as said below. Exhibit checks the rules in this order:
   - **Whitespace.** The same hunk adds the line back, and only whitespace differs. A blank line is whitespace too, unless it moved. In a Python file the indent at the start of a line is code, because it says which block the line is in, so a line whose block changes counts. Exhibit compares the depth of the block, not the indent's characters. So a change from a tab to four spaces at the same depth, such as `\treturn t` to `    return t` when the whole function changed to spaces, is whitespace. A line inside brackets, a triple-quoted string or after a backslash at the end of the line before has no indent that counts. To find the depth, a tab moves to the next multiple of eight columns, as in Python. Without the file, the indent's characters must stay the same. In a JavaScript, TypeScript or Python file, whitespace inside a string is code too, because it changes the text the program makes: `'Total:'` to `'Total: '` counts. Code inside `${ }` in a template literal is code, not string text, so `${ a }` to `${a}` is whitespace. Exhibit reads each line alone, so the next line of a string that spans lines, such as a template literal, reads as code. A quote mark that opens no string, such as an apostrophe in JSX text or a quote in a regex like `/'/`, keeps the whitespace after it on that line. These limits can only make a line count, never drop one. In other files, whitespace inside quotes is whitespace, as in `git diff -w`.
   - **Moved.** The line is in a moved block: lines next to each other that another hunk, in the same file or another file, adds back next to each other in the same order. Only whitespace may differ, as for the whitespace rule: in a Python file the line must stay at the same block depth, and in a JavaScript, TypeScript or Python file the whitespace inside a string must stay the same. The block needs two or more lines with a letter or a digit. Short lines such as `}` or `"count": 4` are in many places, so they must not pair with the same text in an unrelated place. So one moved line, such as `return null;` deleted in one place and added in another, still counts: a real fix can do that. A blank line that another hunk adds back is moved too. A line that the same hunk adds back with the very same text is moved too: only its place changed. But when no line is left after this step, and some lines with a letter or a digit moved inside their own file, those lines count. The fix changed only their place, so their place was the bug. A moved line with no letter or digit, such as `});` or a blank line, stays dropped. For example, chalk/chalk PR 569 "Fix exported styles names" only moves four export lines and a blank line up its file, so the four export lines count. A fix that only moves lines to another file still gets no link.
   - **Comment.** The line is only a comment, and the fix does not turn it back into code. A commented-out line that the fix makes code again counts, because the PR that commented it out may have brought the bug. Version 1 knows comments in JavaScript and TypeScript (`//` and `/* */`, in `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts` and `.cts` files) and in Python (`#`, in `.py` files). A hunk shows only changed lines, so a block comment can open before the hunk. The whole file says whether it did, so a JSDoc text line such as ` * Pads a label.` is a comment even when its `/**` and `*/` are outside the hunk. To read the file, Exhibit skips text in quotes, so `'src/**/*.js'` opens no comment. It reads a regex literal as code, so a `/*` inside one, such as `/[/*]/`, is a rare wrong guess. Without the file, a line that starts with `*` is a comment only when it ends the block with `*/`, when a later line of the hunk closes the block, or when it is a JSDoc tag such as `* @param`. The words of a Python comment are checked against the added code with no whitespace at all, so the indent does not stop a commented-out line from counting. Code can start with `*` too, such as `* qty;` on the line after `const total = price`. A later line closes the block when it starts with `*/`, or when it starts with `*`, ends with `*/` and has no `/*` before that `*/`. So `foo(); /* note */` does not close a block, because it opens its own comment, and the regex line `const re = /a*/` does not close one either.
     A code line where only the comment at its end changed is dropped as a comment too, such as `x = 1; // old note` changed to `x = 1;`, or `x = 1;` changed to `x = 1; // why`. Exhibit takes the comments off the deleted line and off each added line in the same hunk. When an added code line then has the same code, give or take whitespace, the deleted line is dropped. In a Python file the indent must stay the same, as for the whitespace rule. A `//`, `#` or `/*` inside quotes is code, so `url = 'a // b'` changed to `url = 'a // c'` counts. A comment mark counts only at the start of the line or after a space, because a line can be part of a string that opened on an earlier line, such as `http://a.example` in a template string.

   A fix that mixes a real change with these changes keeps only the real lines.
3. Run `git blame` on the parent of the fix's first commit on the main branch, to find the commit that last changed each line. That parent is the main branch just before the fix, so the line numbers match the diff in step 1. A merge commit or a squash merge puts the fix on main as one commit, so this is the first parent of `merge_sha`. "Rebase and merge" copies each of the fix's commits onto main, and `merge_sha` is only the last copy. So Exhibit walks back from `merge_sha` along first parents while the parent commit belongs to the fix PR (mapped as in step 4), and blames the parent of the oldest one. For a merge commit or a squash merge, the walk stops at once, and the parent is often another PR's `merge_sha`, so it costs no request for its pull requests. Git runs with settings that ignore a clone's own diff and blame config, such as `blame.ignoreRevsFile`.
4. Map each commit to its PR. Only a PR merged into the repo's default branch (`default_branch` from `GET /repos/{repo}`) brought a commit to main. Exhibit asks for the default branch once per run. First, a commit that is the `merge_sha` of a PR in the history belongs to that PR, when the PR's `base_ref` is the default branch: a squash merge into main. It also belongs to that PR when the commit is on the first-parent line of the default branch in the clone, whatever `base_ref` says. This is for a repo that renamed its default branch, for example from `master` to `main`: the PRs merged before the rename keep `base_ref` `master`, but their squash commits are on main. So they cost no request, and they keep their link even when GitHub lists no PR for the commit. To find the line, Exhibit takes the tip of the default branch of a remote that points at the repo on GitHub, such as `origin/main`, or else the local branch with that name, and runs `git rev-list --first-parent` once per run. A PR squash merged into a release branch, which a merge commit later brought to main, is not on that line, so GitHub is asked about it. When the clone has no branch with the default branch's name, no commit is on the line. Otherwise Exhibit asks GitHub for the pull requests that hold the commit, and keeps one merged PR. When only one merged PR holds the commit, that PR wins. When more than one does, the first one merged into the default branch wins. So a fix merged into a release branch, and later brought to main by a PR that merges the release branch, maps to that later PR, both for a merge commit and for a squash merge into the release branch. When none of them went to the default branch, the first one merged wins. This also happens after a repo renames its default branch, for example from `master` to `main`, for a commit that is not a `merge_sha` in the history: older PRs keep their old `base.ref`, so for them the first one merged wins, as it did before. Exhibit asks once for each commit. A commit that no merged PR holds, or that GitHub does not know (a 422 or 404 reply), goes to `unlinked_lines`.
5. Drop introducing commits that are newer than the bug report, when the bug report has a date. The bug report is an issue that the fix PR's body links with one of GitHub's closing words, such as "Fixes #12", "closes: #7", "Fixes owner/name#12" or "Fixes https://github.com/owner/name/issues/12". The "owner/name#12" form and a full issue URL count only when they name the same repo. Case does not matter in the repo name. Exhibit asks GitHub for each linked issue and takes its creation time. A line whose commit was written (its `author_time`) after that time is dropped. When the body links more than one issue, the newest one counts. A linked number that is a PR, or that GitHub does not know, gives no date. Issues in other repos are not read.
6. Give each link a confidence score: the number of the fix's lines that point to that PR, divided by all of the fix's counted lines. Dropped lines are not in the count. Unlinked lines are, so the scores add up to 1 only when every line has a PR.

A fix with no lines left after steps 2 and 5 gets no links, and its `no_link_reason` says why (section 8.3).

When a fix's `merge_sha` is not in the clone, a git command fails for that fix, or GitHub answers an error for one of its requests (the linked issue, the pull requests of a commit, or the repo's default branch), Exhibit writes `szz: null` for that PR, prints a warning that names it and the reason, and goes on with the other PRs. A GitHub answer of 401 (a refused token), 403 (a missing permission or a rate limit) or 429 (a rate limit) still stops the run, because every later request would fail too. So does a reply that is not the JSON GitHub should send, and a request that cannot reach GitHub at all. The summary at the end counts these skipped fix PRs, for example "SZZ found links for 0 of 1 fix PRs (1 skipped)", and `--json` gives the count as `szz.skipped`. In a shallow clone, such as the default checkout in GitHub Actions, it prints one warning first: blame there can give old lines to the shallow boundary commit, so links can be wrong. A change to a submodule pointer has no lines, so SZZ skips it.

Every link is shown with its lines and blame output. In `exhibit label`, the person can reject it.

### 9.3 Tests on the base and the head

- Exhibit makes two clean git worktrees, one for the base and one for the head, and runs the test command in each.
- Test results come from JUnit XML. Most runners can write it, including `node:test`, Jest, Vitest and pytest. TAP is a later option.
- Exhibit runs a failing test one more time. A test that fails, then passes, is marked flaky. It is reported, and it never counts as evidence in either direction.

### 9.4 A test that failed before

A test qualifies when it is added or changed in the PR, fails on the base (or does not exist there), and passes on the head. A test that does not exist on the base counts only when it fails against the base code. Exhibit copies the new test file into the base worktree to check this.

### 9.5 Mutation on changed lines

- Exhibit uses adapters for existing tools. Version 1 has two adapters: Stryker for JavaScript and TypeScript, and mutmut for Python.
- Each adapter limits the mutants to the changed lines, or filters the tool's results to those lines.
- Timeouts count as killed. Mutants with no test coverage count as survived and are listed apart.
- A time budget stops the run. A partial run reports its sample size and a 95% interval, and the requirement is met only if the lower bound of the interval reaches `min`.
- Some surviving mutants are equivalent to the original code. The summary lists the survivors so a person can mark one as equivalent. Marked mutants drop out of later runs on the same code.

### 9.6 Probes

A probe runs its command in the head worktree with a time limit. Its status comes from the exit code and the declared artifacts. Exhibit attaches the artifacts to the check and links them from `summary.md`.

### 9.7 Who wrote each check

- Tests that the PR added or changed count as written by the builder.
- Probes with `author: hidden` count as hidden.
- A hidden suite lives outside the PR's repo. CI fetches it with a secret that a PR from a fork never gets. Exhibit only reads the counts. It never copies hidden tests into the exhibit.

### 9.8 Verdict

- `meets_policy` when every requirement is `met`.
- `needs_person` when any requirement is `missing` or `failed`. The summary lists each gap with how to fix it.
- `error` when Exhibit itself failed. An error never becomes `meets_policy`.

### 9.9 Backtest

- The test set is the PRs merged after `--from`.
- Leak check: a rule whose `source` includes a defect from the test set is a leak. The report names it and gives results with and without that rule.
- For each PR in the test set, Exhibit works out what the policy would have required. It compares that with the PR's exhibit if there is one, or with the evidence section of its body. With `--rerun`, it runs the cheap requirements again on the PR's historical base and head.
- Caught: the introducing PR of a test-set defect would have been `needs_person`. Strong catch: the missing requirement matches the defect's category.
- Missed: the introducing PR would have been `meets_policy`.
- False demand: a PR with no escaped defect would have been `needs_person`.
- The report gives these counts for each kind of change, with 95% intervals.

### 9.10 Numbers for the trust ladder

For each kind of change, Exhibit reports:
- The number of PRs.
- Policy misses.
- The upper bound of the miss rate: 3/n when there are zero misses, and a Clopper-Pearson bound otherwise.
- The false-demand rate.
- Results from the blind sample, when the person has recorded them.

Exhibit only reports these numbers. It never changes a rung.

### 9.11 Claude

- Claude is used only by `exhibit label --claude` and `exhibit policy suggest`.
- It needs `ANTHROPIC_API_KEY`. Every command works without it.
- Each draft is marked as a draft until the person confirms it.
- Exhibit records how often the person keeps Claude's draft unchanged. That number measures the drafter.

### 9.12 Storage

- Output goes to `.exhibit/out/` on the local machine.
- In CI, the exhibit is uploaded as a workflow artifact. A short summary is posted as one PR comment, which is updated on each run.
- The JSON is also committed to a data branch, by default `exhibit-data`, at `prs/<number>/<head-sha>.json`. The history cache and reports live there too.

## 10. GitHub Action

- `action.yml` uses the Node 20 runtime.
- Inputs:
  - `command`: `check`, `trace` or `history`.
  - `policy`: the path to the policy file.
  - `data-branch`.
  - `comment`: true or false.
  - `enforce`: false means shadow mode, and the check always succeeds. True means the check fails on `needs_person`.
- Example workflows in `examples/`:
  - On `pull_request`: run `check`.
  - On push to the main branch: run `trace`.
  - Weekly on a schedule: run `history` and `backtest`, then publish the report.
- Permissions: `contents: read` for the check. `contents: write` only for the job that writes the data branch. `pull-requests: write` for the comment.
- Security: the check runs on `pull_request`, never on `pull_request_target`, so code from a PR never runs with a write token. The hidden suite runs only on trusted events.

## 11. Technical decisions

| Decision | Reason |
|---|---|
| Node 20 or later, JavaScript ES modules, few runtime dependencies | GitHub Actions run Node natively. The office's main repo is Node. |
| Use the GitHub GraphQL API for history's PR reads, and the REST API for SZZ, both through `fetch`, with the `gh` CLI optional | `fetch` means one less tool to install. One GraphQL query reads 50 merged PRs with their labels, files, reviews, comments and CI results. The REST API needs one request for each PR and each of those lists: about 5 for each PR. SZZ asks about one commit or one issue at a time, so GraphQL saves it little, and its REST replies use the reply cache (section 8.6). |
| Adapters for mutation tools instead of an own engine | Stryker and mutmut are mature. Version 1 does not need its own engine. |
| JUnit XML for test results | Most test runners can write it. |
| Files and a data branch instead of a server or a database | Anyone can run it, and everything stays in their repo. |
| Tests with `node:test`, and recorded API responses as fixtures | No network access in unit tests. |

Every request to the forge goes through one module, `src/github.js` for GitHub, with one named method for each kind of read: `mergedPulls`, `pullFiles`, `pullReviews`, `pullComments`, `pullFileCount`, `ciResults`, `defaultBranch`, `pullsForCommit` and `issue`. `ciResults` gives each CI result as a name, a conclusion and a URL.

On GitHub, the history methods (`mergedPulls`, `pullFiles`, `pullReviews`, `pullComments`, `pullFileCount` and `ciResults`) use the GraphQL API. `mergedPulls` reads 50 merged PRs in one query, each with the first 100 of its labels, files, reviews and comments, its count of changed files, and the first 100 CI results on its last commit (GitHub's status check rollup, which holds the check runs and the commit statuses). The module keeps what it read, so the other methods send a query only for the next page of a list longer than 100, until the list is complete. The methods give the same fields as the REST API did, so the history file is the same: an empty PR body is null, a bot's login ends in `[bot]`, a conclusion is in small letters, and the check runs come newest first, as the REST API lists them. Each GraphQL query asks for its own cost, so a run can say how many points it used. GitHub gives a GraphQL rate limit as a 200 reply with an error of the type `RATE_LIMITED`: the client waits on it as on a REST rate limit (section 8.3), and any other error reply makes `exhibit history` exit 2 with GitHub's message. The SZZ methods (`defaultBranch`, `pullsForCommit` and `issue`) use the REST API. The module also owns the forge's rules for a repo name (`isRepoName`) and for a remote URL that points at the repo (`isRemote`). History and SZZ take the forge as a parameter, and recorded fixtures sit in one folder for each forge, such as `test/fixtures/github/`. So a second forge, such as GitLab, can come later as a second module with the same methods.

## 12. Field test

Exhibit is built by an office room (Room C), and two other rooms use it on their own repos: the Building58 room on Building58, and Room B on edd-platform.

- **Users install published releases only.** They never run Exhibit from its source.
- **Phase A: history.** Run `exhibit history` on Building58 and edd-platform. Bryan labels the escaped defects. The first policy comes from that.
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
| S6 | Mutation adapters | Stryker first, then mutmut. Only the changed lines are mutated. The budget and the interval work. |
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
| The builder edits the policy to pass its own PR. | A change to `evidence.yml` always gives `needs_person`, and the maintainer reviews it. |

## 16. Open questions

1. The package name. `exhibit` may be taken on npm. A scoped name such as `@bfalkowski/exhibit` is the fallback.
2. The license: decided. Exhibit uses the MIT license (the `LICENSE` file), so anyone may use, change and share it.
3. Where the hidden suite lives, and how CI gets access to it.
4. How to detect fix PRs in repos that use no labels. Section 17.3 lists one lead: an oracle built from fixes that name the change that added the bug.
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
