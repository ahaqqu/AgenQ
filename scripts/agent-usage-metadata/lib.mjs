// Pure logic for the agent-usage-metadata hook (issue #95).
//
// Contract (external boundaries this module guards):
// 1. Hook stdin payload (ZCode workspace-hook runtime). Two capture points
//    are recognized — everything else is a validated no-op:
//    a. `PostToolUse` on the `TaskOutput` tool: the manager collected a
//       background subagent's result; `tool_input.task_id` identifies the
//       agent record.
//    b. `PostToolUse` on the `Agent` tool: a foreground dispatch completed;
//       `tool_use_id` matches the agent record's `parentToolUseId`.
//    (`Stop` is deliberately NOT a capture point: the runtime only fires it
//    for interactive/parent sessions, never for subagent child sessions —
//    verified live — so a Stop capture is dead code that only adds a
//    per-session-stop scan of the agents dir.)
// 2. Telemetry rows: objects shaped like rows of the `model_usage` table in
//    ~/.zcode/cli/db/db.sqlite (snake_case token columns + status/timestamps).
// 3. Agent metadata.json: a JSON object; usage keys are ADDED/REPLACED, every
//    pre-existing key is preserved verbatim. Unparseable or mismatched
//    metadata aborts the update (never corrupts the file).

const USAGE_SOURCE = "scripts/agent-usage-metadata";

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Parse + validate the hook payload. Returns one of:
//   {ok:true, event:"task-output", agentId}
//   {ok:true, event:"agent-dispatch", toolUseId}
//   {ok:false, reason} — never throws.
// Hand-rolled on purpose: this hook only consumes a different event subset
// than the guardrail's valibot envelope (../lib/zcode-hook.ts) — see that
// file for the canonical payload contract before extending either.
export function parseHookPayload(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "payload is not valid JSON" };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, reason: "payload is not a JSON object" };
  }
  const event = payload.hook_event_name;
  if (event === "PostToolUse") {
    const toolName = payload.tool_name;
    const toolUseId = nonEmptyString(payload.tool_use_id);
    if (!toolUseId) return { ok: false, reason: "PostToolUse payload has no tool_use_id" };
    if (toolName === "TaskOutput") {
      const agentId = agentIdFromTaskId(payload.tool_input);
      if (!agentId) {
        return { ok: false, reason: "TaskOutput payload has no agent task_id in tool_input" };
      }
      return { ok: true, event: "task-output", agentId };
    }
    if (toolName === "Agent") {
      return { ok: true, event: "agent-dispatch", toolUseId };
    }
    return { ok: false, reason: `unsupported tool_name: ${String(toolName)}` };
  }
  return { ok: false, reason: `unsupported hook_event_name: ${String(event)}` };
}

// TaskOutput's task_id for a subagent dispatch is the agent id (with or
// without the "agent_" prefix). Same caveat as the guardrail's session-id
// pattern (scripts/iteration-guardrail/scope.mjs): an OBSERVED harness
// convention, not a documented contract — if the id shape changes, this is
// the line to revisit.
function agentIdFromTaskId(toolInput) {
  if (!isPlainObject(toolInput)) return undefined;
  const taskId = nonEmptyString(toolInput.task_id);
  if (!taskId) return undefined;
  return taskId.startsWith("agent_") ? taskId : `agent_${taskId}`;
}

// Query text for model_usage rows of one session. Kept here so the SQL and
// the row-shape contract stay next to the code that consumes the rows.
export const USAGE_ROWS_SQL = `
  select provider_id, model_id, status, started_at, completed_at, duration_ms,
         input_tokens, output_tokens, reasoning_tokens,
         cache_creation_input_tokens, cache_read_input_tokens,
         computed_total_tokens
  from model_usage where session_id = ?`;

function intOrZero(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

// Sum raw model_usage rows into the usage totals. Pure: rows in, totals out.
export function computeUsageTotals(sessionId, rows, capturedAt) {
  const models = new Map();
  let wallStart = Infinity;
  let wallEnd = 0;
  let completedRequestCount = 0;
  const totals = {
    sessionId,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    computedTotalTokens: 0,
    requestCount: rows.length,
    completedRequestCount: 0,
    wallTimeMs: 0,
  };
  for (const row of rows) {
    totals.inputTokens += intOrZero(row.input_tokens);
    totals.outputTokens += intOrZero(row.output_tokens);
    totals.reasoningTokens += intOrZero(row.reasoning_tokens);
    totals.cacheCreationInputTokens += intOrZero(row.cache_creation_input_tokens);
    totals.cacheReadInputTokens += intOrZero(row.cache_read_input_tokens);
    totals.computedTotalTokens += intOrZero(row.computed_total_tokens);
    if (row.status === "completed") {
      completedRequestCount += 1;
      const start = intOrZero(row.started_at);
      const end = intOrZero(row.completed_at);
      if (start > 0) wallStart = Math.min(wallStart, start);
      if (end > 0) wallEnd = Math.max(wallEnd, end);
    }
    const modelKey = `${row.provider_id ?? "?"}/${row.model_id ?? "?"}`;
    const model = models.get(modelKey) ?? {
      model: modelKey,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    model.requestCount += 1;
    model.inputTokens += intOrZero(row.input_tokens);
    model.outputTokens += intOrZero(row.output_tokens);
    models.set(modelKey, model);
  }
  totals.completedRequestCount = completedRequestCount;
  totals.wallTimeMs =
    wallEnd > wallStart && wallStart !== Infinity ? wallEnd - wallStart : 0;
  totals.models = [...models.values()].sort((a, b) => b.requestCount - a.requestCount);
  totals.capturedAt = capturedAt;
  totals.capturedBy = USAGE_SOURCE;
  return totals;
}

// Stable fingerprint of one capture: used to keep usageCaptures append-only
// history idempotent across repeated captures of the same session state.
export function captureFingerprint(totals) {
  return [
    totals.requestCount,
    totals.completedRequestCount,
    totals.inputTokens,
    totals.outputTokens,
    totals.reasoningTokens,
    totals.cacheCreationInputTokens,
    totals.cacheReadInputTokens,
    totals.computedTotalTokens,
    totals.wallTimeMs,
  ].join(":");
}

// Build the next metadata.json content. Pure and total: it either returns a
// full replacement document (all pre-existing keys preserved) or throws on a
// guard violation — the caller must treat a throw as "do not write".
// - metadataText: the current file content (string) — MUST parse.
// - expectedChildSessionId: the child session the usage belongs to — MUST
//   match the record's childSessionId so a scan collision can never write
//   foreign usage.
export function mergeUsageIntoMetadata(metadataText, totals) {
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch (e) {
    throw new Error(`metadata.json is not valid JSON: ${e.message}`);
  }
  if (!isPlainObject(metadata)) {
    throw new Error("metadata.json is not a JSON object");
  }
  if (metadata.childSessionId !== totals.sessionId) {
    throw new Error(
      `metadata childSessionId ${JSON.stringify(metadata.childSessionId)} does not match usage session ${JSON.stringify(totals.sessionId)}`,
    );
  }
  const existingCaptures = Array.isArray(metadata.usageCaptures)
    ? metadata.usageCaptures.filter(isPlainObject)
    : [];
  const fingerprint = captureFingerprint(totals);
  const captures = [
    ...existingCaptures.filter((c) => c.fingerprint !== fingerprint),
    {
      capturedAt: totals.capturedAt,
      fingerprint,
      requestCount: totals.requestCount,
      completedRequestCount: totals.completedRequestCount,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadInputTokens: totals.cacheReadInputTokens,
      wallTimeMs: totals.wallTimeMs,
    },
  ];
  return { ...metadata, usage: totals, usageCaptures: captures };
}

export function serializeMetadata(metadata) {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}
