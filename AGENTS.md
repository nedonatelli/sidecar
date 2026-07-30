# AGENTS.md

Conventions an AI agent needs in order to work in this repo without re-deriving
them. Coding standards, the test layout, and the commit workflow live in
[CONTRIBUTING.md](CONTRIBUTING.md) — this file covers only what that doesn't.

## Issue tracker

Issues live as GitHub issues in `nedonatelli/sidecar`, managed with the `gh`
CLI. Publish specs and tickets there; a bare `#42` refers to an issue in that
repo. External pull requests are not treated as a request surface.

## Triage labels

| Label             | Meaning                                    |
| ----------------- | ------------------------------------------ |
| `bug`             | Something is broken                        |
| `enhancement`     | New feature or improvement                 |
| `needs-triage`    | Not yet evaluated                          |
| `needs-info`      | Waiting on the reporter                    |
| `ready-for-agent` | Fully specified; an agent can implement it |
| `ready-for-human` | Needs human judgement to implement         |
| `wontfix`         | Evaluated and declined                     |

## Architecture Decision Records

ADRs live in [`docs/adr/`](docs/adr/). Read the ones covering an area before
changing it, and don't re-litigate a decision recorded there.

`docs/` is published as a Jekyll site, so a new ADR must follow the existing
shape or it breaks the build:

- **Three-digit** numbering (`007-…`), not four.
- Front matter with `title: "ADR-007: <title>"` and `layout: docs`.
- A row added to the index table in [`docs/adr/README.md`](docs/adr/README.md) —
  an ADR missing from it is invisible to readers.
- Body follows the Nygard template, with a `**Date**: YYYY-MM` line.

There is no `CONTEXT.md` domain glossary; the ADRs and CONTRIBUTING.md are the
written record.
