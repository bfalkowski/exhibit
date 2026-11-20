# Setup note: Exhibit on edd-platform

This note is for Room B, which owns edd-platform. It adds Exhibit to edd-platform in shadow mode, which is phase B of the field test ([docs/spec.md section 12](../../docs/spec.md#12-field-test)). In shadow mode, Exhibit gives its verdict on every PR, but nothing waits on it.

The field repos install published releases only, never Exhibit's source. So this note needs the release `v0.1.0`. It exists once the person pushes the tag `v0.1.0` to Exhibit. Check it at <https://github.com/bfalkowski/exhibit/releases/tag/v0.1.0> before you open the PR.

## What to add

Open one PR in edd-platform that adds two files:

1. [exhibit.yml](exhibit.yml) as `.github/workflows/exhibit.yml`. It runs Exhibit on every PR in two jobs.
2. [evidence.yml](evidence.yml) as `evidence.yml` at the top of the repo. It is the first policy.

Change nothing else in the PR. A PR that changes `evidence.yml` always gets `needs_person`, so this first PR gets it too. That is expected.

## The workflow

The workflow is [examples/pull-request.yml](../pull-request.yml) with three changes:

- The check job sets up uv and Node 22, as edd-platform's CI does. uv runs the API tests, and Node builds the web app. Exhibit runs on the same Node, and needs Node 20 or later.
- Each job has a time limit: 30 minutes for the check job, 10 for the publish job.
- Both jobs pin `bfalkowski/exhibit@v0.1.0`. Keep the same release in both jobs. Do not pin `v0` or `main`. They move, so the check job and the publish job of one run could get different code. To move to a newer release, change both lines in a PR of its own.

## Token permissions

The workflow sets every permission itself, so the repo's default token setting ("Read repository contents") does not matter.

| Job | Permission | Why |
|---|---|---|
| check | `contents: read` | Read the code and the PR. edd-platform is public, so this reads the PR too. The check runs the PR's code, so it gets nothing more. |
| publish | `contents: write` | Push the exhibit to the `exhibit-data` branch. The first run makes the branch. |
| publish | `pull-requests: write` | Post the summary comment on the PR, or update it. |

The publish job never checks out or runs the PR's code. It is skipped for a PR from a fork. No secret is needed: both jobs use the job's own token. The API tests need no secret either, as in CI.

## The first policy

[evidence.yml](evidence.yml) has four kinds of change:

| Kind | Files | Risk | Needs |
|---|---|---|---|
| `api` | `apps/api/`, `docs/openapi.json`, `scripts/` | medium | The API tests on the base and the head. For a fix, a test that fails before the change. |
| `adapter` | `packages/langfuse-adapter/` | medium | The adapter's tests pass on the head (a probe). |
| `web` | `apps/web/` | medium | The web build and its unit tests pass on the head (a probe). |
| `docs` | `docs/` and every Markdown file | low | Nothing yet. The summary still says a person reads it before it merges. |

Any other file, such as CI or the compose files, needs the API tests. A PR is a fix when it has the label `bug`, its title starts with "fix" after the ticket key (such as "T-116: Fix flaky e2e"), or its branch starts with `fix/`.

A real run of this policy, with `exhibit check` on two merged PRs:

- PR 107 (`api`): the API tests ran on the base and the head, and 231 passed on the head. Verdict `meets_policy`.
- PR 111 (`docs` and `web`): the web build and its 61 unit tests passed. Verdict `meets_policy`.

The policy leaves out the end-to-end suite, the Postgres test and the OpenAPI checks, because they need a browser, a database or a step of their own. Each one can come later as a probe. This policy is a start. Phase A of the field test finds edd-platform's escaped defects, and the kinds and their needs come from them later.

## After it merges

- Each PR gets an "Exhibit check" job and an "Exhibit publish" job, and one comment from Exhibit that says "Shadow mode: nothing waits on this."
- Neither job is a required check. edd-platform has no branch protection, so nothing else is needed.
- In phase C of the field test, Room B sets `enforce: true`, in both jobs, when the person says so.
- When Exhibit does something wrong, file an issue in the Exhibit repo and attach the `evidence.json` from the run's `exhibit` artifact (spec 12, "Friction").
