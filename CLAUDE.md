# Exhibit house rules

These rules apply to every session that works on Exhibit.

## Read first

- [docs/spec.md](docs/spec.md) says what Exhibit does: its commands, file formats and build order.
- [docs/index.html](docs/index.html) explains the same design with diagrams.

## Rules

- **Plain words.** Write code comments, docs, PR bodies and commit messages in short sentences with common words and active voice. Use the words from the "Words" table in docs/spec.md section 6.
- **One ticket per pull request.** Each PR does one ticket and names it. Work that the ticket does not ask for goes in a new ticket.
- **Evidence from a real run.** Each PR body shows output from a real run of the changed behavior: the command, and what it printed or wrote. Passing unit tests alone is not enough.
- **Keep the spec true.** When a PR changes what a command does, or changes a file format, it updates docs/spec.md in the same PR.

## Before you open a PR

Run `npm test` and `npm run lint`, and fix what they report.
