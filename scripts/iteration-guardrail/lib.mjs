// Pure logic for the iteration-guardrail hook (issue #98).
//
// Invariant this module protects (must hold even though its owner is a
// guardrail meant to protect others):
//   A deny may fire ONLY on confident evidence of repeated FAILED verification
//   cycles in the current session. It must never fire on distinct-progress
//   work (a different failure, or any successful verification, resets the
//   counters), it must fail OPEN on its own internal errors (a broken
//   guardrail must never trap an agent), and every deny must carry the full
//   stuck-report escalation instruction (issue #94 format).
//
// Everything here is deterministic and pure: state + event in, next state +
// optional deny out. No I/O, no clocks, no randomness — the counting logic is
// testable in isolation and cannot be made non-deterministic by the caller.
//
// Progress model (issue #94, "Escalation guardrail on iterations"):
// - One cycle = a fix attempt (an Edit/Write) + a verification rerun.
// - The stuck signal is the SAME failure recurring after a fix attempt, or a
//   rerun with NO state change between cycles (a bare retry: any output
//   difference is flake, not progress).
// - Both counters reset on a successful verification: a success is evidence
//   the loop converges, so the budget restarts. This is what makes the caps
//   progress-based rather than a raw per-session count that would brick long
//   legitimate sessions.

import { createHash } from "node:crypto";
import { defaultScopeConfig, normalizeScopeConfig } from "./scope.mjs";

// Session-scope config (issue #123): re-exported so hook.mjs and the tests
// keep a single import surface, same as the messages.mjs re-exports below.
export { defaultScopeConfig, isSubagentSession, normalizeScopeConfig } from "./scope.mjs";

export const DEFAULT_SAME_FAILURE_CAP = 3;
export const DEFAULT_DISTINCT_FAILURE_CAP = 8;

// Verification commands, as substring regexes over the Bash command line.
export const DEFAULT_VERIFICATION_PATTERNS = [
  "\\bbun run (check|test|typecheck|lint)\\b",
  "\\bbun test\\b",
  "\\bbunx? (vitest|jest|playwright|tsc|eslint|prettier|pyright|mypy|pytest)\\b",
  "\\b(npm|pnpm|yarn) (run |)(test|check|typecheck|lint)\\b",
  "\\bvitest\\b",
  "\\bpytest\\b",
  "\\bgo test\\b",
  "\\bcargo (test|check|clippy)\\b",
  "\\bmake (test|check|lint)\\b",
  "\\bgh pr checks?\\b",
];

// The internal config shape ALWAYS carries compiled RegExp patterns — every
// producer (defaultConfig, normalizeConfig, hook loadConfig's fallbacks) goes
// through this function, so isVerificationCommand can never receive strings.
// (Bug found by the issue #98 test suite: string defaults used to leak into
// every fallback path, making the hook inert on exactly those paths.)
export function defaultConfig() {
  return {
    ...defaultScopeConfig(),
    sameFailureCap: DEFAULT_SAME_FAILURE_CAP,
    distinctFailureCap: DEFAULT_DISTINCT_FAILURE_CAP,
    verificationPatterns: compilePatterns(DEFAULT_VERIFICATION_PATTERNS),
  };
}

function isPositiveInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function compilePatterns(patterns) {
  if (!Array.isArray(patterns)) return null;
  const compiled = [];
  for (const p of patterns) {
    // Already-compiled entries (e.g. normalizeConfig(defaultConfig())) pass
    // through untouched; strings are compiled; junk is skipped (fail-open).
    if (p instanceof RegExp) {
      compiled.push(p);
      continue;
    }
    if (typeof p !== "string" || p.length === 0) continue;
    // Review C2 hardening: reject oversized patterns outright so a
    // hand-edited config cannot introduce pathological backtracking.
    if (p.length > 200) continue;
    try {
      // Repo-owned config is the same trust boundary as the hook command
      // wiring itself (arbitrary code); inputs are short command lines.
      compiled.push(new RegExp(p, "i")); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    } catch {
      // Invalid pattern: skip it (fail-open), caller logs.
      continue;
    }
  }
  return compiled;
}

// Validate + clamp a config object into the internal shape. Never throws:
// any invalid field falls back to its default (fail-open), and the result
// reports which fields were replaced so the caller can log the degradation.
export function normalizeConfig(raw) {
  const config = defaultConfig();
  const degraded = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config, degraded: ["config is not an object"] };
  }
  if (raw.sameFailureCap !== undefined) {
    if (isPositiveInt(raw.sameFailureCap)) config.sameFailureCap = raw.sameFailureCap;
    else degraded.push("sameFailureCap");
  }
  if (raw.distinctFailureCap !== undefined) {
    if (isPositiveInt(raw.distinctFailureCap)) config.distinctFailureCap = raw.distinctFailureCap;
    else degraded.push("distinctFailureCap");
  }
  if (raw.verificationPatterns !== undefined) {
    const compiled = compilePatterns(raw.verificationPatterns);
    if (compiled && compiled.length > 0) config.verificationPatterns = compiled;
    else degraded.push("verificationPatterns");
  }
  normalizeScopeConfig(raw, config, degraded);
  return { config, degraded };
}

export function isVerificationCommand(command, config) {
  if (typeof command !== "string" || command.trim().length === 0) return false;
  return config.verificationPatterns.some((re) => re.test(command));
}

export function emptyState() {
  return {
    // Consecutive failed cycles with the SAME failure signature (or bare
    // retries with no state change, which count as the same failure).
    sameFailStreak: 0,
    // Failed verification cycles since the last successful verification.
    failCyclesSinceSuccess: 0,
    lastSignature: null,
    lastCommand: null,
    lastFailurePreview: null,
    lastVerificationFailed: false,
    // Whether an Edit/Write happened since the last verification run.
    editSinceLastVerification: false,
  };
}

// Defensive shape check for state loaded from disk. Anything not matching is
// discarded (the caller starts from emptyState) — corrupted state must never
// produce a deny.
const NULLABLE_STRING_KEYS = ["lastSignature", "lastCommand", "lastFailurePreview"];

export function isValidState(state) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return false;
  const ref = emptyState();
  return Object.keys(ref).every((key) => {
    const value = state[key];
    if (NULLABLE_STRING_KEYS.includes(key)) {
      return value === null || typeof value === "string";
    }
    return typeof value === typeof ref[key];
  });
}

function stripAnsi(text) {
  // biome-ignore lint: ESC escape is intentional.
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

// Erase volatile tokens (durations, timestamps, temp paths, pids, memory
// figures, bracketed counters) so two runs of the same failing command
// produce the same signature; then collapse whitespace and keep the tail
// (failure summaries live at the end). Over-normalization trades a rare
// conflated distinct failure for the far worse false negative of the same
// failure reading as progress.
export function normalizeOutput(text) {
  if (typeof text !== "string") return "";
  return stripAnsi(text)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<ts>")
    .replace(/\b\d{13}\b/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<clock>")
    .replace(/\b\d+(?:\.\d+)?m?s\b/g, "<t>")
    .replace(/\bpid[=: ]\d+|\(\d+\)/gi, "<pid>")
    .replace(/\b\d+(?:\.\d+)? ?(?:[KMGT]i?B)\b/g, "<mem>")
    .replace(/\/tmp\/[\w./-]+/g, "<tmp>")
    .replace(/\[\d+\]/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-2000);
}

export function normalizeCommand(command) {
  return typeof command === "string" ? command.replace(/\s+/g, " ").trim() : "";
}

// Deterministic failure identity: normalized command + normalized output.
export function failureSignature(command, outputText) {
  const digest = createHash("sha256")
    .update(normalizeCommand(command))
    .update("\n")
    .update(normalizeOutput(outputText))
    .digest("hex");
  return digest.slice(0, 16);
}

// Narrow the runtime-owned Bash tool_response (unknown at the contract
// boundary) into "success" | "failed" | "indeterminate". Success requires
// POSITIVE evidence (exitCode === 0) — a failure envelope that omits the
// field must never reset the counters (found by review as A3: the old
// default treated missing exitCode as success). Indeterminate outcomes
// (cancelled, backgrounded, spawn errors, unrecognized shapes) are never
// counted — an uncountable outcome can only make the guardrail quieter,
// never deny without evidence.
export function outcomeFromToolResponse(toolResponse) {
  const r = toolResponse;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return "indeterminate";
  if (r.timedOut === true) return "failed";
  const status = typeof r.status === "string" ? r.status : undefined;
  if (status === "cancelled" || status === "backgrounded" || status === "spawn_error") {
    return "indeterminate";
  }
  if (typeof r.exitCode === "number" && r.exitCode !== 0) return "failed";
  if (status === "failed" || status === "timed_out") return "failed";
  if (typeof r.exitCode === "number" && r.exitCode === 0) return "success";
  return "indeterminate";
}

const FAILURE_PREVIEW_MAX = 300;

function previewOf(outputText) {
  const normalized = normalizeOutput(outputText);
  return normalized.length > FAILURE_PREVIEW_MAX
    ? `${normalized.slice(0, FAILURE_PREVIEW_MAX)}…`
    : normalized;
}

// Apply one finished verification attempt. Returns the next state; never
// mutates the input. Bare retries (no Edit/Write since the previous
// verification) count toward the same-failure streak ONLY when the SAME
// command is being retried (review A1): different verification commands
// failing in a non-editing session are distinct verifications, not retries
// of one failure — three red `gh pr checks` on different PRs must never arm
// the same-failure cap. Same-command no-edit reruns still count regardless
// of output — nothing changed, so a different result is flake, not progress.
export function applyVerificationResult(state, { command, outcome, outputText }) {
  const next = { ...state };
  if (outcome === "success") {
    // A success is progress evidence: reset both counters (see module header).
    return {
      ...emptyState(),
      // Keep the last command context for observability in logs.
      lastCommand: normalizeCommand(command) || null,
    };
  }
  if (outcome !== "failed") return state; // indeterminate: no evidence, no change
  const signature = failureSignature(command, outputText);
  const sameCommandRetry =
    state.lastVerificationFailed &&
    !state.editSinceLastVerification &&
    normalizeCommand(command) === state.lastCommand;
  const sameFailure = sameCommandRetry || signature === state.lastSignature;
  next.sameFailStreak = sameFailure ? state.sameFailStreak + 1 : 1;
  next.failCyclesSinceSuccess = state.failCyclesSinceSuccess + 1;
  next.lastSignature = signature;
  next.lastCommand = normalizeCommand(command) || null;
  next.lastFailurePreview = previewOf(outputText);
  next.lastVerificationFailed = true;
  next.editSinceLastVerification = false;
  return next;
}

export function applyStateChange(state) {
  return { ...state, editSinceLastVerification: true };
}

// The deny decision. Fires only while the run is in a verified failing loop
// (lastVerificationFailed) AND a cap is exceeded. Distinct-progress work
// (a success, or a different failure) resets the relevant counter, so a deny
// is always backed by repeated same-context evidence.
export function evaluateDeny(state, config) {
  if (!state.lastVerificationFailed) return null;
  if (state.sameFailStreak >= config.sameFailureCap) {
    return {
      cap: "sameFailureCap",
      count: state.sameFailStreak,
      limit: config.sameFailureCap,
    };
  }
  if (state.failCyclesSinceSuccess >= config.distinctFailureCap) {
    return {
      cap: "distinctFailureCap",
      count: state.failCyclesSinceSuccess,
      limit: config.distinctFailureCap,
    };
  }
  return null;
}

// Deny-message construction lives in messages.mjs (review B1 split);
// re-exported here so consumers and tests keep a single import surface.
export { buildDenyOutput, buildDenyReason } from "./messages.mjs";

