# Exhibit

Every pull request brings its own evidence. Exhibit decides what evidence a PR needs, checks that the evidence is strong, and learns from each bug that gets through.

**Status:** design stage. The spec is written. The project setup exists: `npm ci`, then `npm test` and `npm run lint`. CI runs both, and a secret scan, on every pull request. `exhibit history --repo owner/name` exports the merged PRs, with their files, reviews and CI results, to `.exhibit/history.jsonl`. It needs `GITHUB_TOKEN`: docs/spec.md section 8.3 lists the permissions the token needs. It has no SZZ yet.

- [Explainer with diagrams](docs/index.html): start here.
- [Spec](docs/spec.md): commands, file formats, how each part works, and the build order.

## The idea

When agents open more pull requests than a person can read, the question changes. It is no longer "is this code good?" It becomes "is this evidence strong enough that nobody needs to read the code?"

Exhibit answers that question in four steps:

1. **Learn from history.** It traces each fix back to the PR that added the bug, and turns what got through into rules in `evidence.yml`.
2. **Check each PR.** It runs the tests on the base and the head, looks for a test that failed before and passes now, measures how many planted bugs the tests catch on the changed lines, and runs any probes the policy names.
3. **Give a verdict.** The verdict is "meets policy" or "needs a person", and it always lists the gaps.
4. **Measure itself.** A backtest shows what the policy would have caught on past PRs. For each kind of change, Exhibit reports misses and false demands, so a person can decide when to stop reading the code for that kind.

## Planned commands

```
exhibit history     # read past PRs and find the bugs that got through
exhibit label       # error analysis, with optional Claude drafts
exhibit backtest    # test the policy on past PRs
exhibit check       # check one PR against the policy
exhibit trace       # after a merge, find policy misses
```

Exhibit will be a CLI and a GitHub Action. It needs no server.

## How it is built

An office room of Claude Code sessions in [Building58](https://github.com/bfalkowski/Building58) builds Exhibit. Two other rooms use it on their own repos and file issues here. See section 12 of the spec.
