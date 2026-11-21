---
name: review-page
description: "Build and open a local browser page where the person reviews many items one at a time (labels, drafts, approvals, keep or reject) instead of answering a long run of questions in the terminal. Use when a task needs the person's judgment on more than about 5 similar items, such as labeling bugs or traces, accepting Claude's drafts, or sorting findings, or when the person says the questions are too many or unclear."
---

# Review page

Some steps need a person's judgment on many similar items: label 27 escaped defects, accept 40 of Claude's drafts, keep or reject 60 SZZ links. Asked one by one in the terminal, the person sees one question at a time, without the evidence beside it, and loses track of what they approve and why. A page fixes that: one item per screen, the evidence in its own form, a few big buttons, and a save on every click.

The pattern comes from hamelsmu/evals-skills, `build-review-interface` (MIT).

## In Exhibit

- To label escaped defects, use `exhibit label --review`. It is this pattern, built into Exhibit, and it writes `.exhibit/labels.jsonl` in the right format (docs/spec.md section 8.4). It also asks the person to keep or reject each SZZ link, and writes the rejected ones to `rejected_prs`, which the backtest reads. Do not build a second page for labels or for SZZ links.
- Use this skill for the other reviews that have no command yet, such as reading a blind sample, or keeping or dropping the rules that `exhibit policy suggest` drafts, when it is built.
- Use the words from the "Words" table in docs/spec.md section 6 on the page: escaped defect, introducing PR, deferral, policy miss, verdict. Say "escaped defect", not "bug" or "issue", when you mean one.
- The page writes `answers.jsonl` in the scratchpad, never into `.exhibit/`. Only Exhibit's own commands write `.exhibit/` files, because they check each line against its schema.

## When to use it

- More than about 5 items that each need the same kind of decision.
- The decision needs evidence that does not fit in a question: a diff, a PR, a trace, a long text.
- The person asks why there are so many questions, or says they do not know what they approve.

For 5 items or fewer, one table in chat with a recommendation for each is faster.

## 1. Say what the person decides

Before you build anything, write three short lines. They go at the top of the page, and in a help panel.

- **Why** this review exists: what the answers are used for later.
- **What** one decision is, in the person's words, not code words.
- **When to say no or skip**, with one example.

If you cannot write these lines, you do not understand the task well enough to ask the person yet.

## 2. Get the items into one file

- Write a script that reads the source data and writes `items.json`: one object for each item, with an `id`, the evidence to show, and Claude's draft answer if there is one.
- Keep picking and sorting in the script, not in the page.
- Do not change the project's own data files to fit the page. The page reads `items.json` and writes `answers.jsonl`. When the project has its own answer format, the script converts at the end, or the page writes that format directly. In Exhibit, do neither: see "In Exhibit" above.

## 3. Build the page

One HTML file with inline CSS and JS, and one small Node server with no dependencies (`node:http`, `node:fs`). Bind it to `127.0.0.1` only, on a free port. Put both in the session's scratchpad, or in the project when the project will keep the page.

Show each item like this:

- **At the top:** the item's ID, its counter ("12 of 27, 15 left"), and one plain line that says what it is.
- **The evidence, in its own form:** a diff as a diff, markdown rendered, JSON pretty-printed, links that can be clicked. Put the parts that matter most first, and fold long parts into `<details>`.
- **The draft**, when there is one: every field can be edited in place.
- **Categories** as a pick list of the names used so far, plus "New...". Free text makes "flaky test" and "Flaky tests" two categories. When the answers are grouped later, that splits one group into two.
- **The buttons:** Accept (1), Edit (2), No or skip (3), Later (D), Back and Next (arrow keys). Accept and No look different, by color and place.
- **A side list** of every item and its state (open, accepted, edited, no, later), so the person can jump back.
- **A help panel** (`?`) with the three lines from step 1.

How it saves:

- On each click, the page sends the answer to the server, and the server adds one line to `answers.jsonl`: the `id`, the decision, the edited fields, and the time. The last line for an `id` wins, so Back and a new answer work.
- On load, the page reads `answers.jsonl` and starts at the first open item, so a closed tab loses nothing.
- Never write a hidden or default answer for an item the person did not touch.

At the end, show a summary: the counts by decision and by category, the items left for later, and what the answers now allow (for example "3 categories each have 2 or more labeled escaped defects, so each can become a rule").

## 4. Check it, then open it

- Start the server in the background, open the page in a browser, and answer two items. Check that `answers.jsonl` has those two lines, then reload and check that the page starts at item 3. Remove the two test lines after.
- Then open the page for the person: `open http://127.0.0.1:PORT/`. Tell them in two lines what they decide, and where the answers go.

## 5. Use the answers

- Read `answers.jsonl` only when the person says they are done, or for the summary while they work.
- Report the counts, and any item where the person changed Claude's draft. Those changes show where the drafts go wrong.
- Stop the server when the review is over.

## Rules

- The page is local. Do not publish it, and do not send the items to an outside service.
- Claude drafts. The person decides. The page never accepts a draft by itself.
- Keep the words on the page the same as the project's glossary, and the same on every screen. In Exhibit, the glossary is docs/spec.md section 6.
