# mend: one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/RieryBuild/makefun-hidden-spec-cli-01-run-20261122-v4/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/RieryBuild/makefun-hidden-spec-cli-01-run-20261122-v4/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON —
and `mend` reads each one exactly as [`SPEC.md`](SPEC.md) says. Every file is
changed or nothing is: a failed edit changes nothing, the edits after it still
run, and when any edit failed no file is written at all.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format".

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory
  (the root of the tree). When `PATCH` is absent or is `-`, the patch is read
  from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Old lines are found at the first of three matching tiers at which they occur:
exact, then ignoring trailing spaces and tabs, then ignoring leading and
trailing spaces and tabs (with re-indentation at tier 2).

## Exit codes

- `0` — the tree is written. One line per changed path (`A`/`D`/`M`/`R`),
  then `ok: <n> files`.
- `1` — nothing written: one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`.
- `2` — nothing written: exactly one line, `error: usage`, `error: no-patch`,
  `error: format` or `error: parse <N>`.

## Files

- `main.ts` — the CLI. Node 22, standard library alone, no dependencies.
- `runner.ts` — the kit's trial runner (kept as handed out).
- `check.ts` — runs the practice set on your own machine.
- `SPEC.md` — the whole specification (version 1).

## Practice

The kit carries the public practice set at `program/generator/practice.json`.
This entry scores **100/100 (practice score 1000)** on it, and passes a
355-test hand-built edge suite covering the specification sentence by sentence,
including the tier-1/2 fuzzy matching, nearest-occurrence hunks, V4A
anchor/cursor/EOF rules, JSON CRLF and overlap counting, state-based `R`
lines, and the final-line-break rules.

## License

MIT — see [`LICENSE`](LICENSE).
