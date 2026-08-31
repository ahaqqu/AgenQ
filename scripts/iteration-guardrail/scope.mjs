// Session-scope gate for the iteration-guardrail hook (issue #123).
//
// The guardrail applies to the manager workflow's subagent dispatches only:
// interactive sessions (e.g. `/goal`) must never be touched. The decision is
// a regex match on the hook payload's `session_id` against the observed
// harness convention `^sess_subagent_agent_` — an OBSERVED CONVENTION, not a
// documented contract (making the harness's id shape a contract is a
// ZCode-client matter, out of scope for #123).
//
// Fail-open direction: a wrong pattern fails OPEN silently (the guardrail
// goes inert for sessions it should guard) — this is the safe side of the
// hook's invariant (a broken guardrail must never trap an agent). The
// mitigation for that silence is the rate-limited `warn_scope_zero_match`
// event (hook.mjs), not a tighter default here.

export const DEFAULT_SCOPE = "subagents-only";
export const SCOPES = ["subagents-only", "all"];
// Observed ZCode convention for manager subagent dispatch session ids.
export const DEFAULT_SUBAGENT_PATTERN = "^sess_subagent_agent_";

// The internal shape ALWAYS carries a compiled RegExp (same discipline as
// verificationPatterns in lib.mjs) so isSubagentSession can never receive a
// string.
export function defaultScopeConfig() {
  return {
    scope: DEFAULT_SCOPE,
    subagentSessionRegex: new RegExp(DEFAULT_SUBAGENT_PATTERN),
  };
}

function compileSubagentPattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 200) return null;
  try {
    return new RegExp(pattern); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp — repo-owned config, same trust boundary as the hook wiring
  } catch {
    return null;
  }
}

// Merge the scope fields of a raw config into `config`, pushing the names of
// any invalid fields onto `degraded` (fail-open to defaults). Never throws.
export function normalizeScopeConfig(raw, config, degraded) {
  if (raw.scope !== undefined) {
    if (SCOPES.includes(raw.scope)) config.scope = raw.scope;
    else degraded.push("scope");
  }
  if (raw.subagentSessionPattern !== undefined) {
    const compiled = compileSubagentPattern(raw.subagentSessionPattern);
    if (compiled) config.subagentSessionRegex = compiled;
    else degraded.push("subagentSessionPattern");
  }
}

// The scope decision: does this session fall under the guardrail? `all`
// matches every session (pre-#123 behavior); `subagents-only` matches only
// session ids the configured pattern accepts.
export function isSubagentSession(config, sessionId) {
  if (config.scope === "all") return true;
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  const regex =
    config.subagentSessionRegex instanceof RegExp
      ? config.subagentSessionRegex
      : new RegExp(DEFAULT_SUBAGENT_PATTERN);
  return regex.test(sessionId);
}
