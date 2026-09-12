# AGENTS.md

## Pull requests

Both gates below apply to PRs that change the running app — a diff touching any
of `monitor.mjs`, `harness/**`, `public/**`, `install.sh` or
`package.json`. A PR that touches none of them (docs, skills, agent-instruction
files) has no rendered behavior to verify and no README surface to update: say
that in the PR description instead of running the app.

Before opening a PR, check that `README.md` is up to date with the change:

- UI changes: retake the affected screenshots in `docs/` and update them (and their alt text) in the README. Screenshots are **whole-page** captures at the board's normal viewport width — the entire page, not just the first viewport-full. Don't reuse stale captures. Two board quirks bite stitched captures, so handle them: click the live pill (top right) to freeze the 1.5s re-render before capturing, or scroll-bands tear, and pin the sticky top bar to normal flow first (`position: static`), or it repeats at every band boundary.
- Behavior/feature changes: update the README section that describes the feature (and the source list in `docs/data-sources.md` if the data AgenQ reads changes).
- If nothing in the README is affected, say so in the PR description instead of silently skipping the check.

Before opening a PR, run a smoke test of the running app and record the result in the PR description:

- Start the server (`bun monitor.mjs` on a spare `--port`) and exercise it in a real browser, not just with `curl`:
  - the board renders (totals, agent tree, Active Now strip, tool ticker, sparkline canvases painted);
  - the interactive paths work: project filter, clicking an Active Now chip expands the lazy detail panel, the 💬 button opens the live conversation tab and it streams new items;
  - screenshots go in the PR description (or `docs/`) as evidence when UI changed.
- An endpoint returning 200 is not a smoke test — the deliverable is the page a user sees, so verify rendered behavior. If a check cannot be run (e.g. no ZCode telemetry on the machine), say so explicitly in the PR description instead of implying it passed.