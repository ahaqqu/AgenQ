---
name: code-review
description: Use when reviewing a pull request after it is created. The single review entry point — sets the review depth (normal for docs/skill-only changes, thermos mandatory for anything touching code) and verifies philosophy and guardrail compliance.
source: project
synced: 2026-08-29
---

# Code Review

Use this skill when reviewing a pull request after it has been created. It is the single entry point for all review: the thermo passes are reached through this skill — always via `.agents/skills/thermos-with-comments/SKILL.md`, which posts the itemized findings on the PR.

## Review depth (determined by the change, not negotiated)

- **Normal** — this skill's philosophy and guardrail review only. Allowed only when the PR touches **no code**: docs, skills, agent-instruction files, ADRs, specs, and similar non-runtime surfaces.
- **Thermos (mandatory for code)** — if the diff touches any runtime code (`apps/`, `packages/`, `scripts/`, migrations, CI workflows), run `.agents/skills/thermos-with-comments/SKILL.md`: dispatch both thermo-nuclear sub-reviewers (security/correctness + maintainability) and post the itemized findings as PR comments. This is not optional and not a recommendation — a PR that changes code is always reviewed at thermos depth.

There is no third depth. If a PR mixes code and docs, thermos applies to the whole PR.

Under the manager-orchestrated loop, the `reviewer` role applies this skill and posts findings as itemized PR comments via `.agents/skills/thermos-with-comments/SKILL.md` instead of synthesizing in chat — same passes, same depth rule, comment-based deliverable.

## Inputs

- The pull request diff.
- `docs/ARCHITECTURE.md` — verify the changes align with philosophy.
- `AGENTS.md` — verify the changes comply with guardrails.

## Philosophy alignment

For each principle below, check if the PR upholds or violates it:

- **Cost**: Does the PR add a paid service or a metered external API to the critical path of a monitor that is meant to run free and offline?
- **Local-first**: Does the PR keep every telemetry read local and read-only (DBs opened `mode=ro` per poll, log/config/state files only read)? Does it bind `127.0.0.1` and avoid network egress, rather than blocking the board on a remote call?
- **Performance**: Does the PR add a full-file read to a poll, block the serving loop, or break the lazy per-session detail/conversation path? Does it respect the ~1.5s snapshot and ~2s conversation cadence and the DSH incremental frame decode (only frames appended since the previous poll; untouched logs skipped entirely)?
- **Harness-agnostic**: Does the PR keep harness-specific logic inside `harness/<id>/`, let the registry namespace ids (`zcode:`, `hermes:`, `deepseek:`), and add a new harness as an adapter directory plus one registry entry with no frontend change? Does core import harness internals? (Linux is the supported platform by design — `/proc`, `flock`, `install.sh`.)
- **Polished**: Does the PR change UI without retaking the README screenshots whole-page (freeze the live pill, pin the sticky top bar to normal flow) and updating their alt text? Does it consider the board's keyboard/scroll behavior?
- **Secure**: Does the PR widen the stop-run write path — offering it for a harness without `hasStop: true`, dropping below project-level granularity, losing the confirmation that names the harness and process count, skipping SIGTERM for SIGKILL, or accepting a cross-origin request?
- **Observable**: Does the PR degrade silently instead of reporting through the snapshot's `warnings` — a damaged frame, a skipped log, a refused read that the board never mentions?
- **Maintainable**: Does the PR leak harness specifics into core, put logic in the wrong layer, or sprawl a module that should be split by responsibility the way `frames`/`fold`/`log` split the DSH adapter?
- **Available**: Does the PR fail the poll instead of failing empty — does `snapshot()` throw on a missing or empty installation, or does one damaged DSH frame silence the rest of a session?
- **Reliable**: Does the PR change behavior without the AGENTS.md browser smoke test (board renders, project filter, an Active Now chip opens the lazy detail panel, the 💬 button streams the live conversation) and without the result recorded in the PR description?
- **Reproducible**: Does the PR add a tool or a step outside Bun ≥ 1.1 and the zero-build `install.sh` path? Are `package.json` and `bun.lock` changed together?
- **Agentic**: Are files small and self-describing? Are the adapter contract and snapshot shape clear? Does `docs/harness-data-parity.md` stay truthful about what each harness can and cannot supply?

## Guardrail compliance

For each changed file, verify against these guardrails:

- Telemetry is read-only: SQLite DBs opened `mode=ro` per poll, log/config/state files only ever read, nothing written back to a harness.
- The server binds `127.0.0.1` only; no outbound network calls; no secrets committed.
- Adapters implement the `harness/<id>/index.mjs` contract in `harness/README.md`; a new harness is one adapter directory plus one registry entry in `harness/index.mjs`.
- Session ids are namespaced by the registry (`zcode:`, `hermes:`, `deepseek:`); adapters deal in raw ids and emit their own `parentId`/`children` tree edges.
- `snapshot()` returns the empty shape for a missing or empty installation and never throws on it; damaged or refused data is reported in `warnings`.
- A genuinely broken telemetry read throws, so the registry records a per-harness failure and surfaces it as a board warning.
- Status values come from the shared vocabulary (`running`, `sleep`, `done`, `failed`, `idle`, `exited`); `done`/`exited` mapping is the adapter's responsibility.
- Routes are the `monitor.mjs` API surface (`/api/state`, `/api/session/:id/detail`, `/api/session/:id/messages`, `POST /api/stop`); per-session endpoints stay lazy.
- Poll cadence is preserved (snapshot ~1.5s, conversation ~2s); no full-file read is added to a poll.
- DSH logs are decoded incrementally — only frames appended since the previous poll, untouched logs skipped — and a damaged frame is dropped without losing the events after it.
- Styling is plain CSS in `public/index.html` with vanilla JS in `public/`; no framework, bundler, or runtime CSS-in-JS.
- Runtime dependency count stays zero; Bun ≥ 1.1 supplies the API and `valibot` stays confined to the ZCode hook payload schema.
- The stop action exists only where the harness sets `hasStop: true`, only at project level, behind a confirmation naming the harness and process count, with SIGTERM before SIGKILL.
- The stop endpoint rejects cross-origin requests.
- `package.json` and `bun.lock` change together, and `install.sh` plus the README flag list stay in sync with any new flag.

## Posting contract (any PR comment, incl. thermos findings)

- **One individual review comment per finding.** Each finding exists as its own review comment carrying a stable ID; a summary comment may index the items but must never be the only place a finding exists. Dispositions thread on the original comment (see the manager skill §4).
- **Line-anchored by default.** Any finding with a locatable anchor must be an inline review comment on its file and line, resolved via the diff (`gh pr diff --patch` → diff position), and must quote or reference the offending line so the thread is self-contained.
- **PR-level fallback is justified, not silent.** Reserve PR-level comments for genuinely unanchorable findings (cross-cutting, process notes); the comment itself must open with the justification, e.g. "no single anchorable line: …".
- **Stale pending-draft preflight.** GitHub allows one pending review per user per pull request (its 422 text: "user_id can only have one pending review per pull request"); a stale PENDING review draft under the authenticated account forces 422s on review-comment creation. Before posting itemized comments, list `gh api repos/{owner}/{repo}/pulls/{n}/reviews`, and delete any PENDING draft (`gh api -X DELETE repos/{owner}/{repo}/pulls/{n}/reviews/<review_id>`).

## Output

Report:
- Philosophy violations: which principle is violated, which file, and why.
- Guardrail violations: which rule is broken, which file and line.
- Thermo findings (when code was touched): the itemized report posted by thermos-with-comments (A/B/C IDs), merged and prioritized.
- Approval or rejection with justification.

Block the PR on any MUST or MUST NOT violation. Flag SHOULD violations for author response.
