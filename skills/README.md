# Claude Code skills

Exhibit asks a person to judge many items: label escaped defects, accept Claude's drafts, keep or reject SZZ links. In the terminal, that is one question at a time, without the evidence beside it. These skills teach Claude Code a better way to ask.

A skill is a folder with a `SKILL.md` file. Claude Code reads the file's `name` and `description`, and loads the rest when a task fits, or when you type `/name`.

| Skill | What it does |
|---|---|
| [review-page](review-page/SKILL.md) | Builds a local page in the browser where a person reviews many items one at a time, and saves each answer at once. |

## Install a skill

Link or copy the skill's folder into one of these places:

- `~/.claude/skills/` for every project on your computer.
- `.claude/skills/` in one project, for that project only.

A link keeps the skill up to date when you pull Exhibit:

```
ln -s /path/to/exhibit/skills/review-page ~/.claude/skills/review-page
```

A copy stays as it is:

```
cp -R /path/to/exhibit/skills/review-page ~/.claude/skills/
```

If `~/.claude/skills/review-page` is there already, for example from an earlier copy, move it away first. Otherwise `ln -s` fails, or makes a link inside the old folder.

Start a new Claude Code session. The skill shows as `/review-page` in the skill list.

## Credits

The review-page pattern comes from `build-review-interface` in [hamelsmu/evals-skills](https://github.com/hamelsmu/evals-skills) (MIT).
