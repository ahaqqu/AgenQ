# AGENTS.md

## Pull requests

Before opening a PR, check that `README.md` is up to date with the change:

- UI changes: retake the affected screenshots in `docs/` and update them (and their alt text) in the README. Screenshot the running board at its normal viewport — don't reuse stale captures.
- Behavior/feature changes: update the README section that describes the feature (and the "Where the data comes from" table if sources change).
- If nothing in the README is affected, say so in the PR description instead of silently skipping the check.

Before opening a PR, run a smoke test of the running app and record the result in the PR description:

- Start the server (`bun monitor.mjs` on a spare `--port`) and exercise it in a real browser, not just with `curl`:
  - the board renders (totals, agent tree, Active Now strip, tool ticker, sparkline canvases painted);
  - the interactive paths work: project filter, clicking an Active Now chip expands the lazy detail panel, the 💬 button opens the live conversation tab and it streams new items;
  - screenshots go in the PR description (or `docs/`) as evidence when UI changed.
- An endpoint returning 200 is not a smoke test — the deliverable is the page a user sees, so verify rendered behavior. If a check cannot be run (e.g. no ZCode telemetry on the machine), say so explicitly in the PR description instead of implying it passed.