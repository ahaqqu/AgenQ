// Scope-gate observability and persistence for the iteration-guardrail hook
// (issue #123; review round A1/A2/A3/B3 on PR #124).
//
// This is the I/O-flavored counterpart to the pure `scope.mjs`: it owns the
// warn-marker and scope-intent-cache files under a `scope/` subdirectory of
// the guardrail state dir, and the no-op gate itself. `emit` is injected so
// this module stays decoupled from the hook's stderr transport.
//
// Namespace (review A3): everything written here lives in the `scope/`
// subdirectory, disjoint from the counting state files in the state dir root
// — no session id can collide with a counting file, and the reviewer's
// `subagentSessionPattern: "scope$"` scenario is impossible by construction.
// Marker growth is bounded: at most one file per non-matching session that
// ever ran a verification command (the marker's own existence rate-limits
// the warn). The existsSync/write pair is a known TOCTOU, accepted: hook
// events for a session are lifecycle-ordered by the harness, and the worst
// case is one duplicate warn stderr line on a best-effort observability
// event — strictly fail-open, no invariant gain from locking.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCOPES, isSubagentSession } from "./scope.mjs";

const SCOPE_STATE_SCHEMA_VERSION = 1;

// Shared naming discipline with the counting state files: session ids are
// sanitized identically wherever they become a filename.
export function stateFileName(sessionId) {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return `${safe}.json`;
}

function scopeDir(statePath) {
  return join(dirname(statePath), "scope");
}

export function warnMarkerPath(statePath, sessionId) {
  return join(scopeDir(statePath), `warn-${stateFileName(sessionId)}`);
}

function scopeCachePath(statePath) {
  return join(scopeDir(statePath), "last-good.json");
}

// Rate-limited (once per session, via the marker's own existence) zero-match
// warn: a non-matching session still running verification commands is the
// signature of a silently-wrong scope pattern and must be observable.
export function warnZeroMatchOnce(emit, markerPath, sessionId, config) {
  try {
    if (existsSync(markerPath)) return; // already warned this session
    mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, warnedAt: new Date().toISOString() }));
    emit("warn_scope_zero_match", {
      sessionId,
      scope: config.scope,
      hint: "session ran verification commands but matched nothing all session; check scope/subagentSessionPattern in scripts/iteration-guardrail/config.json",
    });
  } catch (e) {
    // Observability is best-effort: a failed warn must never block the call.
    emit("error_state_write", { path: markerPath, reason: e.message });
  }
}

// The scope gate (issue #123): returns true when the hook must no-op for
// this session (non-matching under the configured scope) — no counting-state
// read/write, no deny. `verificationCommand` is the single classification
// result (review B2): non-null means the event is verification activity, the
// only trace a no-op session may leave is the rate-limited zero-match warn.
export function scopeGateNoop(emit, { config, sessionId, statePath, verificationCommand }) {
  if (isSubagentSession(config, sessionId)) return false;
  if (verificationCommand !== null) {
    warnZeroMatchOnce(emit, warnMarkerPath(statePath, sessionId), sessionId, config);
  }
  return true;
}

// --- Scope-intent persistence (review A1) ----------------------------------
// An unreadable config, or one whose scope fields degrade, must not silently
// flip an operator-configured `scope: "all"` to the subagents-only default
// (that would stop counting for every session, invisibly). The last config
// that loaded with valid scope fields is cached; the hook consults it on
// degradation and emits `warn_scope_degraded` when the cache rescues the
// decision. With no cache (first run), the residual direction stays
// fail-open to the built-in defaults — documented in the Scope section.

function validScopeFields(raw) {
  const fields = { schemaVersion: SCOPE_STATE_SCHEMA_VERSION };
  if (raw && typeof raw === "object") {
    if (SCOPES.includes(raw.scope)) fields.scope = raw.scope;
    const pattern = raw.subagentSessionPattern;
    if (typeof pattern === "string" && pattern.length > 0 && pattern.length <= 200) {
      fields.subagentSessionPattern = pattern;
    }
  }
  return fields;
}

export function loadScopeFields(statePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(scopeCachePath(statePath), "utf8"));
  } catch {
    return null; // no cache yet — first run or wiped state dir
  }
  if (!parsed || parsed.schemaVersion !== SCOPE_STATE_SCHEMA_VERSION) return null;
  const { schemaVersion, ...fields } = validScopeFields(parsed);
  return Object.keys(fields).length > 0 ? fields : null;
}

// Remember the current config's scope fields whenever they are valid. An
// intentionally empty result (config without scope fields) is still written:
// it clears stale intent when the operator removes the fields. Writes are
// skipped when the content is unchanged (this runs on every event).
export function saveScopeFields(statePath, raw) {
  const path = scopeCachePath(statePath);
  const payload = JSON.stringify(validScopeFields(raw));
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === payload) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, payload);
  } catch {
    // Best-effort cache: a failed write means the next degradation falls
    // back to the built-in defaults (the documented residual direction).
  }
}
