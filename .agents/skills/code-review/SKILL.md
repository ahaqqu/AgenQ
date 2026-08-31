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

For each principle in `docs/ARCHITECTURE.md`, check if the PR upholds or violates it:

- **Cost**: Does the PR add paid dependencies? Does it move compute to the edge that belongs on the client?
- **Local-first**: Does the PR preserve CRDT merge semantics? Does it block the UI on network?
- **Performance**: Does the PR increase bundle size? Does it add runtime CSS-in-JS?
- **Cross-Platform**: Does the PR introduce platform-specific code?
- **Polished**: Does the PR include i18n for `en` + `id`? Does it consider accessibility?
- **Secure**: Does the PR touch auth, payments, or external boundaries without Valibot validation from `@app/contracts`?
- **Observable**: Does the PR add logging without the Logger adapter?
- **Maintainable**: Does the PR access `env.*` directly? Does it add Cloudflare-specific types to business logic? Does it change schema without migrations?
- **Available**: Does the PR fail hard instead of degrading gracefully?
- **Reliable**: Does the PR lack tests for changed logic? Does it reduce coverage?
- **Reproducible**: Does the PR introduce tools not in the Nix flake?
- **Agentic**: Are files small and self-describing? Are contracts clear?

## Guardrail compliance

For each changed file, verify against `AGENTS.md` universal guardrails and the `guided-implementation` domain checklist:

- External service access uses adapters in `packages/infra`. No direct `env.*` access.
- Routes have Valibot schemas in `packages/contracts` (`@app/contracts`), use `hono-openapi`, and are under `/v1/`.
- Database changes include raw SQL migrations in `apps/api/migrations/`, client migrations in `packages/local-first`, and a `SCHEMA_VERSION` bump.
- User-facing strings are externalized for `en` and `id`. No hardcoded copy.
- Dates, numbers, and currency use the `Intl` API.
- Styling uses Tailwind CSS only. No runtime CSS-in-JS.
- Sync logic uses the custom LWW-element-set CRDT in `packages/local-first` (`mergeNotes`). Tinybase is not used.
- Sync retries with exponential backoff; requests carry `schemaVersion` and `clientVersion`.
- Logging uses the Logger adapter with structured JSON. No `console.log`.
- SQL uses only standard features. No SQLite-specific or D1-specific extensions.
- Session storage uses D1. No KV write-path.
- Dependencies are free-tier compatible. No paid services in the critical path.
- Secrets are injected via `wrangler secret`. Nothing committed to the repo.
- Files are 300 lines or fewer with 5 or fewer direct dependencies.
- Webhook handlers verify signatures before parsing; are idempotent.

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
