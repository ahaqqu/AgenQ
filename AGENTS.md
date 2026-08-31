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

## Code review workflow (required for every PR)

Every PR goes through the `code-review` skill before (or immediately after) opening it. The skill sets the depth: `normal` for docs/skill-only changes, `thermos` (the two thermo-nuclear sub-reviewers) for anything touching code.

1. **Run the review with subagents.** Invoke the `code-review` skill against the PR branch; dispatch the review passes (security/correctness + code-quality at thermos depth) as subagents, never as inline solo reads. Collect their findings as lettered items (A1, A2… B1, B2…).
2. **Address every core-review finding.** Fix or explicitly rebut each item with a code change on the PR branch. Don't batch fixes silently — each finding gets a visible response.
3. **Reply in-thread.** Answer each review comment by replying directly in that comment's thread (GitHub review comments: `gh api repos/…/pulls/comments/<id>/replies`), stating what was addressed and how (commit, reverted reasoning, or why no change is needed). Never post a new top-level comment where an in-thread reply is expected.
4. **Update the PR description.** It must contain, at minimum:
   - a summary of the change;
   - a screenshot of the result (UI changes; `docs/` or embedded);
   - smoke-test results from the running app;
   - a table of code-review feedback with a row per finding and what was done about it (`Addressed: <hash/summary>` / `Rebutted: <reason>`).

The review loop closes when all findings have an in-thread reply and the PR description's table covers them all.