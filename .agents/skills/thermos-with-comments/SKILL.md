---
name: thermos-with-comments
description: Thermos depth of the `code-review` skill — runs the two thermo-nuclear review passes (security/correctness + code quality) and posts each finding as an itemized GitHub review comment (A1, A2…, B1, B2…, C1, C2…) with a summary comment and recommendation. Loaded by `code-review` (mandatory for code-touching PRs) and the manager's `reviewer` role — never dispatched directly.
disable-model-invocation: true
source: project
synced: 2026-08-29
---

# Thermos With Comments

> **Library skill** — not an entry point. Reached only through the `code-review` skill (its thermos depth) and the manager's `reviewer` role.

Use this skill when a review's findings must land on the PR as individually-referencable, itemized comments — the manager-orchestrated implement → review → fix loop, and the only thermos arm `code-review` ever calls. It runs the two thermo passes (standards inherited from `thermo-nuclear-review/SKILL.md` and `thermo-nuclear-code-quality-review/SKILL.md`) and posts the itemized report to the PR instead of synthesizing in chat, returning the same itemized report to the caller.

The review standards are inherited from `thermo-nuclear-review/SKILL.md` (security/correctness) and `thermo-nuclear-code-quality-review/SKILL.md` (maintainability). Load both into the dispatched subagents.

## Reviewer subagent types

This skill is designed to run inside a `reviewer` coordinator subagent (`.zcode/agents/reviewer.md`), which dispatches two sub-reviewers in parallel: `subagent_type: "thermo-nuclear-review-subagent"` for security/correctness and `subagent_type: "thermo-nuclear-code-quality-review-subagent"` for maintainability. All three are defined as role agents in `.zcode/agents/` with per-role pinned models (see `.zcode/agents/README.md`); delete a sub-reviewer's `model:` field to make it inherit the `reviewer` coordinator's model. If a harness lacks these types, fall back to its generic subagent and inline the prompts from the two sibling skills.

## Workflow

1. Resolve the PR: `gh pr view` for the current branch (or a PR number the caller hands you). Record the PR number and head SHA.
2. Launch both reviewer subagents in the same message, `run_in_background: true`, passing them the same scoped diff + PR context. Ask each to return a prioritized, numbered list of findings.
3. Synthesize: merge the two reviews. Deduplicate overlapping findings, weight overlaps more heavily, resolve disagreements with your own judgment. Do not restate each reviewer wholesale — the deliverable is one unified, itemized report.
4. Assign each finding a **stable item ID**:
   - `A1, A2, …` — security / correctness findings (from the security reviewer).
   - `B1, B2, …` — code-quality / maintainability findings (from the quality reviewer).
   - `C1, C2, …` — post-synthesis / cross-cutting findings (from your own merge: conflicts, systemic issues, or findings neither reviewer caught alone).
   - Never renumber after publication. If a finding is withdrawn later, mark it `withdrawn — <reason>`; do not reuse its ID.
5. Build each item's payload. Every item has:
   - `**[ID]**` prefix — e.g. `**[A1]**` — so users can instruct fixes by ID without ambiguity.
   - Priority (High / Medium / Low).
   - `file:line` anchor when the changed line is identifiable; otherwise a file + region.
   - Evidence (concrete code reference or behavior trace, no speculation).
   - Recommended fix.
6. **Stale pending-draft preflight.** GitHub allows one pending review per user per pull request (its 422 text: "user_id can only have one pending review per pull request"), so a stale PENDING review draft under the authenticated account forces 422s on review-comment creation. List `gh api repos/{owner}/{repo}/pulls/{n}/reviews` and delete any PENDING draft (`gh api -X DELETE repos/{owner}/{repo}/pulls/{n}/reviews/<review_id>`) before posting.
7. Post **one GitHub review comment per item** — the summary never substitutes for it; every item must exist as an individual comment.
   - **Mandatory line-anchoring**: every item with any locatable anchor is an inline review comment on its file and line — resolve the diff position from `gh pr diff --patch`, then post via `gh api repos/{owner}/{repo}/pulls/{n}/comments -f body=… -f commit_id=<head-sha> -f path=<path> -F position=<diff-position>`. Each comment quotes or references the offending line so the thread is self-contained.
   - Fall back to a **PR-level comment** via `gh api repos/{owner}/{repo}/issues/{n}/comments` only for genuinely unanchorable findings (cross-cutting, process notes); the comment must open with the justification, e.g. "no single anchorable line: …". Never silently drop a finding because anchoring failed.
   - Verify each comment landed (`gh api repos/{owner}/{repo}/pulls/{n}/comments` or `gh pr view --comments`); the completion criterion for posting is "every item ID is present in the PR discussion".
8. Post one **summary comment** (via `gh api repos/{owner}/{repo}/issues/{n}/comments`) with:
   - An item index table: `ID | Priority | File | Short title` for every posted item.
   - An overall recommendation: `approve`, `request-changes`, or `escalate` (when evidence is inconclusive or the fix requires the author's judgment).
   - Per-item fix recommendations (the same text as each comment, in one place for triage).
   - A line stating that items can be addressed individually by ID, e.g. "Reply to individual comments with **accept** or **reject** plus reasoning. If you only want a subset fixed, instruct by ID, e.g. 'fix A1–A3, reject B2'."
9. Return to the caller (the manager): the PR URL, the full itemized report (all IDs, priorities, files, one-line summaries, and each item's posted review-comment ID so dispositions can thread on the original comment), and the posted-comment verification result.

## Comment body template (per item)

```markdown
**[A1]** (High) `apps/api/src/routes/notes.ts:42`

<One-sentence finding statement.>

**Evidence.** <Concrete code quote, behavior trace, or reproduction. No "maybe".>

**Recommended fix.** <Specific structural or behavioral change.>
```

## Summary comment template

```markdown
## Thermos review — <head-sha-short>

**Recommendation:** <approve | request-changes | escalate>

| ID | Priority | File | Finding |
| --- | --- | --- | --- |
| A1 | High | `apps/api/src/routes/notes.ts:42` | <short title> |
| B1 | Medium | `apps/web/src/components/NoteList.tsx:118` | <short title> |

### Per-item recommendations

- **[A1]** — <recommended fix>
- **[B1]** — <recommended fix>

Reply to individual comments with **accept** or **reject** plus reasoning. To apply a subset, instruct by ID, e.g. "fix A1–A3, reject B2".
```

## Critical rules

- NEVER post a finding you have not traced end-to-end (same standard as the underlying thermo skills).
- NEVER skip posting because anchoring failed — justify the PR-level fallback in the comment itself.
- NEVER let the summary be the only place a finding exists — each item is an individual, line-anchored review comment; the summary indexes.
- NEVER renumber or reuse item IDs after publication.
- If CI is red or the PR has unresolved merge conflicts, still post the review — but mark the recommendation `escalate` and say why.
