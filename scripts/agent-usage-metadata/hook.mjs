#!/usr/bin/env bun
// ZCode workspace hook (issue #95): append a subagent's real token usage to
// its agent metadata.json automatically.
//
// Wiring (enabled in .zcode/config.json, trusted via `zcode hooks trust
// grant` or the desktop review flow). Capture points, in the order they fire
// in the manager loop:
// - PostToolUse on `Agent`: a foreground dispatch completed (tool_use_id maps
//   to the agent record's parentToolUseId).
// - PostToolUse on `TaskOutput`: the manager collected a background
//   subagent's result (task_id maps to the agent record's agentId). This is
//   the reliable capture point for background dispatches, because the child
//   usage rows in the telemetry DB are final once its result is collected.
// There is deliberately no `Stop` capture: the runtime fires Stop only for
// interactive/parent sessions (verified live), where there is nothing to
// record and every event would trigger a full agents-dir scan.
//
// For each capture we sum the child session's `model_usage` rows in the
// local telemetry DB and merge the totals into the agent record's
// metadata.json (found by scanning the agents dir).
//
// Guarantees (the invariant this script protects):
// - Lossless across resumes: totals are recomputed from the FULL
//   model_usage row set of the child session on every capture, so a resumed
//   (continued) subagent — whose new turns append rows to the same session
//   id — accumulates correctly, and repeated captures are idempotent
//   (fingerprint-deduped history).
// - Never corrupts: metadata.json is parsed and validated before any write;
//   writes are atomic (tmp file + rename in the target dir). Any guard
//   failure means "do not write".
// - Observable: every skip/failure emits a structured JSON line on stderr and
//   to the JSONL sidecar log (default ~/.zcode/cli/agent-usage-metadata.log)
//   and exits non-zero on failure. Never exits 2 (must not block tools).
//
// Environment overrides (used by tests): ZCODE_DB_PATH, ZCODE_AGENTS_DIR,
// ZCODE_AGENT_USAGE_LOG.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { atomicWrite, emitEvent } from "../lib/hook-io.mjs";
import {
  USAGE_ROWS_SQL,
  computeUsageTotals,
  mergeUsageIntoMetadata,
  parseHookPayload,
  serializeMetadata,
} from "./lib.mjs";

const DEFAULT_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const DEFAULT_AGENTS_DIR = join(homedir(), ".zcode", "cli", "agents");
const DEFAULT_LOG = join(homedir(), ".zcode", "cli", "agent-usage-metadata.log");

function emit(event, fields) {
  emitEvent("agent-usage-metadata", event, fields, process.env.ZCODE_AGENT_USAGE_LOG || DEFAULT_LOG);
}

function readStdin() {
  return readFileSync(0, "utf8");
}

// Scan the agents dir (one folder per parent session:
// agents/<parentSessionId>/agent_<agentId>/) for the record matching the
// capture — by agentId (TaskOutput) or parentToolUseId (Agent dispatch).
function findAgentRecordPath(agentsDir, match) {
  let parents;
  try {
    parents = readdirSync(agentsDir);
  } catch {
    return { ok: false, reason: `agents dir not readable: ${agentsDir}` };
  }
  for (const parent of parents) {
    const parentDir = join(agentsDir, parent);
    let agents;
    try {
      if (!statSync(parentDir).isDirectory()) continue;
      agents = readdirSync(parentDir);
    } catch {
      continue;
    }
    for (const agent of agents.filter((a) => a.startsWith("agent_"))) {
      const metadataPath = join(parentDir, agent, "metadata.json");
      let text;
      try {
        text = readFileSync(metadataPath, "utf8");
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // Unrelated/unreadable record; never scanned into.
      }
      const matches =
        (match.agentId && parsed.agentId === match.agentId) ||
        (match.parentToolUseId && parsed.parentToolUseId === match.parentToolUseId);
      if (matches) {
        return { ok: true, path: metadataPath, text, childSessionId: parsed.childSessionId };
      }
    }
  }
  return { ok: false, reason: `no agent record matching ${JSON.stringify(match)}` };
}

function queryUsageRows(dbPath, sessionId) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { ok: false, reason: `cannot open telemetry DB ${dbPath}: ${e.message}` };
  }
  try {
    const rows = db.prepare(USAGE_ROWS_SQL).all(sessionId);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, reason: `telemetry DB query failed: ${e.message}` };
  } finally {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
}

// Shared tail: resolve the record's child session, read its usage, merge,
// write. Returns the process exit code.
function captureUsage(record, dbPath) {
  if (!record.childSessionId) {
    emit("error_metadata_guard", { path: record.path, reason: "agent record has no childSessionId" });
    return 1;
  }
  const usage = queryUsageRows(dbPath, record.childSessionId);
  if (!usage.ok) {
    emit("error_db", { sessionId: record.childSessionId, reason: usage.reason });
    return 1;
  }
  if (usage.rows.length === 0) {
    // No usage rows yet: writing zeros would be a lie. Skip.
    emit("skip_no_usage_rows", { sessionId: record.childSessionId });
    return 0;
  }
  const totals = computeUsageTotals(record.childSessionId, usage.rows, new Date().toISOString());
  let nextText;
  try {
    // Re-read immediately before merging: the runtime can rewrite
    // metadata.json on lifecycle transitions, so merge against the freshest
    // bytes to keep the read-modify-write window as small as possible.
    const freshText = readFileSync(record.path, "utf8");
    nextText = serializeMetadata(mergeUsageIntoMetadata(freshText, totals));
  } catch (e) {
    emit("error_metadata_guard", { sessionId: record.childSessionId, path: record.path, reason: e.message });
    return 1;
  }
  try {
    atomicWrite(record.path, nextText);
  } catch (e) {
    emit("error_write", { sessionId: record.childSessionId, path: record.path, reason: e.message });
    return 1;
  }
  emit("usage_recorded", {
    sessionId: record.childSessionId,
    path: record.path,
    requestCount: totals.requestCount,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
    wallTimeMs: totals.wallTimeMs,
  });
  return 0;
}

async function main() {
  const parsed = parseHookPayload(readStdin());
  if (!parsed.ok) {
    emit("skip_payload", { reason: parsed.reason });
    return 0; // Not this hook's event — silent success, nothing written.
  }
  const dbPath = process.env.ZCODE_DB_PATH || DEFAULT_DB;
  const agentsDir = resolve(process.env.ZCODE_AGENTS_DIR || DEFAULT_AGENTS_DIR);

  let match;
  let capture;
  if (parsed.event === "task-output") {
    capture = "task-output";
    match = { agentId: parsed.agentId };
  } else if (parsed.event === "agent-dispatch") {
    capture = "agent-dispatch";
    match = { parentToolUseId: parsed.toolUseId };
  } else {
    // parseHookPayload only yields the two events above; this is a
    // defensive guard, not a dispatch path — nothing is scanned.
    emit("skip_payload", { reason: `unsupported event after parse: ${String(parsed.event)}` });
    return 0;
  }

  const record = findAgentRecordPath(agentsDir, match);
  if (!record.ok) {
    // No agent record for this capture (e.g. the parent/interactive session,
    // or a foreground dispatch that produced no record): observable no-op,
    // tagged with the capture point so misses are distinguishable in logs.
    emit("skip_no_agent_record", { capture, match, reason: record.reason });
    return 0;
  }
  return captureUsage(record, dbPath);
}

const code = await main();
process.exit(code);
