// Shared hook infrastructure: structured event emission and atomic file
// replacement. Both workspace hooks (agent-usage-metadata, iteration-
// guardrail) went through this module so a third hook can't clone a third
// dialect (review B3).
import { appendFileSync, closeSync, fsyncSync, openSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Emit one structured JSON event line to stderr, and optionally to a
 * size-rotated JSONL sidecar log. Best-effort on the sidecar: stderr always
 * carries the record; a logging failure must never fail the hook.
 *
 * @param {string} script    stable script name inside every record
 * @param {string} event     event name
 * @param {object} fields    event payload
 * @param {string} [logPath] when given, the line is also appended to this
 *                           JSONL sidecar (rotated at LOG_MAX_BYTES)
 */
export function emitEvent(script, event, fields, logPath) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    script,
    event,
    ...fields,
  });
  process.stderr.write(`${line}\n`);
  if (!logPath) return;
  try {
    try {
      const { size } = statSync(logPath);
      if (size > LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`);
    } catch {
      // Missing log file is fine; appendFileSync creates it.
    }
    appendFileSync(logPath, `${line}\n`);
  } catch {
    // Sidecar logging is best-effort; stderr already carries the record.
  }
}

// Atomic replace: write the sibling temp file, fsync the file, rename over
// the target, then fsync the directory so the rename itself is durable.
export function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
    const dir = openSync(dirname(filePath), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw e;
  }
}