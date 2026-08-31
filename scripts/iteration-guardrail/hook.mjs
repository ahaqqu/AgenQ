#!/usr/bin/env bun
// ZCode workspace hook (issue #98): mechanical iteration guardrail.
//
// Wiring (.zcode/config.json):
// - PreToolUse  on `Bash`         -> evaluate the caps; deny a verification
//                                    rerun past them with the stuck-report
//                                    escalation instruction (issue #94).
// - PostToolUse on `Bash`         -> record the verification outcome
//                                    (success / failed) into per-session state.
// - PostToolUse on `Edit|Write`   -> record a fix attempt (state change).
// - PostToolUseFailure on `Bash`  -> harness-level tool failure counts as a
//                                    failed verification cycle.
//
// Guarantees (the invariant this hook protects):
// - Deny ONLY on confident evidence of repeated failed verification cycles
//   for the same problem in the current session; never on distinct-progress
//   work (successes and different failures reset the counters — see lib.mjs).
// - Fail OPEN: any internal error (unreadable config, corrupted state,
//   unexpected exception, missing session identity) exits 0 without a deny.
//   A broken guardrail must never trap an agent. (The runtime additionally
//   treats a failed hook as a no-op — this is belt and braces, not a substitute.)
// - Every deny carries the full stuck-report instruction; the completion
//   criterion (PR + checks green) is unchanged by this hook.
//
// Environment overrides (used by tests): ZCODE_GUARDRAIL_CONFIG (config path),
// ZCODE_GUARDRAIL_STATE_DIR (state dir), ZCODE_SESSION_ID, ZCODE_PROJECT_DIR.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
// Relative TS import: bun (and vitest) transpile it, and the repo's isolated
// linker does not expose workspace packages to root-level scripts.
import { parseZcodeHookPayload } from "../lib/zcode-hook.ts";
import {
  applyStateChange,
  applyVerificationResult,
  buildDenyOutput,
  buildDenyReason,
  defaultConfig,
  emptyState,
  evaluateDeny,
  isVerificationCommand,
  isValidState,
  normalizeConfig,
  outcomeFromToolResponse,
} from "./lib.mjs";
import {
  loadScopeFields,
  saveScopeFields,
  scopeGateNoop,
  stateFileName,
} from "./scope-observability.mjs";

const STATE_SCHEMA_VERSION = 1;

function emit(event, fields) {
  // Structured JSON on stderr only. Never exit non-zero for logging problems.
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), script: "iteration-guardrail", event, ...fields })}\n`,
  );
}

function readStdin() {
  return readFileSync(0, "utf8");
}

// The hook must be fast and quiet: an absent/unknown session identity means
// the counters cannot be keyed — no-op (fail-open), never deny.
function resolveSessionId(payload) {
  if (typeof payload.session_id === "string" && payload.session_id.length > 0) {
    return payload.session_id;
  }
  const env = process.env.ZCODE_SESSION_ID;
  if (typeof env === "string" && env.length > 0) return env;
  return null;
}

function resolveStateDir(payload) {
  if (process.env.ZCODE_GUARDRAIL_STATE_DIR) return process.env.ZCODE_GUARDRAIL_STATE_DIR;
  const projectDir = process.env.ZCODE_PROJECT_DIR || payload.cwd || process.cwd();
  const key = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  return join(tmpdir(), "zcode-iteration-guardrail", key);
}

function loadState(statePath) {
  let text;
  try {
    text = readFileSync(statePath, "utf8");
  } catch {
    return null; // First event of the session — nothing loaded is normal.
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    emit("skip_corrupt_state", { path: statePath, reason: "state file is not valid JSON" });
    return null;
  }
  if (!parsed || parsed.schemaVersion !== STATE_SCHEMA_VERSION || !isValidState(parsed.state)) {
    emit("skip_corrupt_state", { path: statePath, reason: "state file failed shape validation" });
    return null;
  }
  return parsed.state;
}

// Atomic replace (tmp + fsync + rename) so a crash never leaves a torn state
// file that could be misread as evidence. Created 0600 in a 0700 dir
// (review A4): the state lives in the shared $TMPDIR, under the same user as
// the guarded agent — it is tamperable by that process (advisory guardrail,
// see docs/ITERATION-GUARDRAIL.md), but it must not be world-readable since
// it stores command lines and failure-output previews.
function saveState(statePath, state) {
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, state }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, statePath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    emit("error_state_write", { path: statePath, reason: e.message });
    // Fail-open: the next event reloads (possibly stale) state; a stale
    // state can only undercount, which stays on the safe side of the invariant.
  }
}

// `notify` scopes the stderr warnings to verification-relevant events
// (review A2): base semantics only loaded config for Bash events carrying a
// command, so Edit/Write events stay silent even when the config is
// degraded. `statePath` enables the scope-intent cache (review A1).
function loadConfig(notify = true, statePath = null) {
  const path = process.env.ZCODE_GUARDRAIL_CONFIG || join(dirname(fileURLToPath(import.meta.url)), "config.json");
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // Scope-intent persistence (review A1): config loss must not silently
    // flip an operator's `scope: "all"` to the subagents-only default (that
    // would stop counting for every session, invisibly). The last
    // known-good scope fields are reused; only with no cache at all does the
    // fail-open default apply (the documented residual direction).
    const cached = statePath ? loadScopeFields(statePath) : null;
    if (cached) {
      const rescued = normalizeConfig(cached);
      if (notify) emit("warn_scope_degraded", { path, reason: e.message, fallback: "last-known-good scope intent" });
      return { config: rescued.config, degraded: ["unreadable config file (scope intent preserved)"] };
    }
    if (notify) emit("warn_config", { path, reason: e.message, fallback: "built-in defaults" });
    return { config: defaultConfig(), degraded: ["unreadable config file"] };
  }
  const normalized = normalizeConfig(raw);
  const scopeDegraded =
    normalized.degraded.includes("scope") || normalized.degraded.includes("subagentSessionPattern");
  if (statePath) {
    if (scopeDegraded) {
      const cached = loadScopeFields(statePath);
      if (cached) {
        const rescued = normalizeConfig({ ...raw, ...cached });
        if (notify) {
          emit("warn_scope_degraded", { path, degraded: normalized.degraded, fallback: "last-known-good scope intent" });
        }
        return { config: rescued.config, degraded: rescued.degraded };
      }
    } else {
      saveScopeFields(statePath, raw);
    }
  }
  if (normalized.degraded.length > 0 && notify) {
    emit("warn_config", { path, degraded: normalized.degraded, fallback: "defaults for degraded fields" });
  }
  return normalized;
}

function commandFrom(payload) {
  const input = payload.tool_input;
  if (input && typeof input === "object" && typeof input.command === "string") {
    return input.command;
  }
  return null;
}

// Shared plumbing for the three Bash branches (review B2): consume the
// already-classified command and load the session state once. Returns null
// when the event is not a classified verification call on Bash.
function resolveVerificationContext(command, statePath, config) {
  if (command === null) return null;
  return { command, config, state: loadState(statePath) ?? emptyState() };
}

// Single source of truth (review B2) for "this Bash payload carries a
// classified verification command", shared by the scope gate (activity
// signal) and the counting path so the two can never drift.
function classifyVerification(payload, config) {
  if (payload.tool_name !== "Bash") return null;
  const command = commandFrom(payload);
  return command !== null && isVerificationCommand(command, config) ? command : null;
}

async function main() {
  const parsed = parseZcodeHookPayload(JSON.parse(readStdin()));
  if (!parsed.ok) {
    emit("skip_payload", { reason: parsed.reason });
    return 0;
  }
  const payload = parsed.payload;
  const sessionId = resolveSessionId(payload);
  if (!sessionId) {
    emit("skip_no_session", {});
    return 0;
  }
  const statePath = join(resolveStateDir(payload), stateFileName(sessionId));
  // Notify decision needs no config (review A2): exactly the events that
  // reached config loading at base — Bash payloads carrying a command.
  const notify = payload.tool_name === "Bash" && commandFrom(payload) !== null;
  const { config } = loadConfig(notify, statePath);
  // Classification runs once per event (review B2), shared by the gate and
  // the counting branches; the gate no-ops non-matching sessions (issue #123).
  const command = classifyVerification(payload, config);
  if (scopeGateNoop(emit, { config, sessionId, statePath, verificationCommand: command })) return 0;

  if (payload.hook_event_name === "PreToolUse") {
    if (payload.tool_name !== "Bash") return 0;
    const ctx = resolveVerificationContext(command, statePath, config);
    if (!ctx) {
      // Either not a Bash-with-command payload or not a classified
      // verification command — both pass through untouched.
      if (commandFrom(payload) === null) emit("skip_no_command", {});
      return 0;
    }
    const breach = evaluateDeny(ctx.state, ctx.config);
    if (breach) {
      emit("deny", { sessionId, breach, signature: ctx.state.lastSignature, streak: ctx.state.sameFailStreak });
      process.stdout.write(`${buildDenyOutput(buildDenyReason(ctx.state, ctx.config, breach))}\n`);
      return 0;
    }
    return 0;
  }

  if (payload.hook_event_name === "PostToolUse") {
    if (payload.tool_name === "Edit" || payload.tool_name === "Write") {
      saveState(statePath, applyStateChange(loadState(statePath) ?? emptyState()));
      return 0;
    }
    if (payload.tool_name !== "Bash") return 0;
    const ctx = resolveVerificationContext(command, statePath, config);
    if (!ctx) return 0;
    const outcome = outcomeFromToolResponse(payload.tool_response);
    const outputText =
      payload.tool_response && typeof payload.tool_response === "object"
        ? `${payload.tool_response.stderr ?? ""}\n${payload.tool_response.stdout ?? ""}`
        : "";
    emit("verification_result", { sessionId, outcome, command: ctx.command.slice(0, 200) });
    saveState(statePath, applyVerificationResult(ctx.state, { command: ctx.command, outcome, outputText }));
    return 0;
  }

  // PostToolUseFailure: the tool call itself errored (harness level). A
  // cancelled call (is_interrupt) is not a verification cycle — nothing was
  // verified, so it must not count as evidence. The error message is the
  // failure output for the signature.
  if (payload.tool_name !== "Bash") return 0;
  if (payload.is_interrupt === true) {
    emit("skip_interrupted", { sessionId });
    return 0;
  }
  const ctx = resolveVerificationContext(command, statePath, config);
  if (!ctx) return 0;
  emit("verification_failure_event", { sessionId, command: ctx.command.slice(0, 200) });
  saveState(
    statePath,
    applyVerificationResult(ctx.state, {
      command: ctx.command,
      outcome: "failed",
      outputText: payload.error?.message ?? "",
    }),
  );
  return 0;
}

try {
  const code = await main();
  process.exit(code);
} catch (e) {
  // Top-level fail-open: no malformed payload, missing module, or I/O error
  // may ever block a tool call.
  emit("error_fatal", { reason: e instanceof Error ? e.message : String(e) });
  process.exit(0);
}
