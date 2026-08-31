// Deny-message construction for the iteration-guardrail hook (issue #98).
// Extracted from lib.mjs (review B1) to keep each file under the 300-line
// cap; lib.mjs re-exports both functions so consumers and tests keep a
// single import surface.
//
// The stuck-report escalation instruction carried by EVERY deny (issue #94
// format). The receiver must be able to act without re-deriving the history.

// The exact JSON a PreToolUse hook prints (exit 0) to deny the tool call.
// Shape verified against the ZCode runtime: hookSpecificOutput.permissionDecision
// "deny" blocks the call and permissionDecisionReason becomes the tool error
// the agent sees.
export function buildDenyOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

export function buildDenyReason(state, config, breach) {
  return [
    `ITERATION GUARDRAIL: verification-loop cap reached (${breach.cap}: ${breach.count} failed cycles >= limit ${breach.limit}). Escalate now — do not rerun verification.`,
    "",
    "This workspace hook blocks verification reruns after repeated FAILED cycles for the same problem in this session. To continue, stop looping and send the manager a stuck-report containing exactly:",
    "1. Invariant under test — the property the work must protect, stated so the receiver can verify it.",
    "2. Exact current failure — the verification command and the precise error output (last recorded signature: " +
      `${state.lastSignature ?? "unknown"}, command: ${state.lastCommand ?? "unknown"}).`,
    "3. Attempted fixes — every fix attempt you made, each with its outcome.",
    "4. Ruled-out hypotheses — what you already eliminated and how.",
    "5. Checkpoint commit ref — commit your work to the branch FIRST, then record the ref here (escalation must never lose work).",
    "",
    "Run the checkpoint commit as its own command: compound commands that contain a verification step are also blocked (review A6).",
    "",
    "Last recorded failure (truncated): " + (state.lastFailurePreview ?? "unknown"),
    "",
    `Caps are configurable in scripts/iteration-guardrail/config.json (sameFailureCap: ${config.sameFailureCap}, distinctFailureCap: ${config.distinctFailureCap}); a fresh session dispatched with a different approach starts with clean counters.`,
    "",
    "Never fake done: the completion criterion is unchanged — a PR must exist and all its checks must be green. Do not report success without that evidence; report the stuck-report instead.",
  ].join("\n");
}
