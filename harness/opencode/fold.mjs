// Shared fold of newest-first assistant rows: one walk feeds the card
// (sparkline, context peak, standing error), the detail panel (turns,
// thinking, current tool, errors) and the ticker. Splitting it per consumer
// let error/clearing semantics drift — the detail panel showed an error the
// card had cleared — so every predicate lives here exactly once:
//
//   * a row is a *success* when it carries `tokens` and no `error`;
//   * the standing error is the newest error, cleared by any newer success;
//   * tool calls are every tool block, newest-first (rows newest-first,
//     parts within a row last-first).
//
// stats.mjs reuses the same two predicates in SQL (`type = 'assistant'` rows
// carrying `data.tokens`) because it needs the whole history, not one
// window — see the query there.
import { jsonCol, tail, usageFromTokens } from "../lib.mjs";
import { contentParts, partText, toolEntry, toolInput, toolParts } from "./parts.mjs";

const THINKING_CAP = 600;
const TOOL_INPUT_CAP = 800;

/**
 * Fold one session's newest-first assistant rows.
 * `turnCap` bounds the newest-first turn rows (the detail panel's page);
 * the card passes 0 and reads no turns.
 */
export function foldAssistantWindow(rowsNewestFirst, { turnCap = 0 } = {}) {
  const prompts = []; // prompt tokens per successful request, oldest-first
  let maxContext = 0;
  let hasReasoning = false;
  let lastSuccessAt = null;
  let thinking = null;
  const errors = []; // every error, newest-first, annotated cleared-by-newer-success
  const turns = [];
  const toolCalls = []; // every tool block, newest-first
  let newestPart = null;
  let successSeen = false;

  for (const r of rowsNewestFirst) {
    const d = jsonCol(r.data, null);
    if (!d) continue;
    const at = d.time?.completed ?? r.time_created;

    if (d.error) {
      errors.push({
        type: String(d.error.type ?? "error"),
        message: String(d.error.message ?? "").slice(0, 300),
        at,
        cleared: successSeen,
      });
    }
    if (!thinking) {
      const text = partText(contentParts(d).find((p) => p?.type === "reasoning"));
      if (text.trim()) thinking = { text: tail(text, THINKING_CAP), at: r.time_created };
    }

    const parts = toolParts(d);
    for (let i = parts.length - 1; i >= 0; i--) {
      const e = toolEntry(parts[i], r.time_created);
      if (!newestPart) newestPart = parts[i];
      toolCalls.push({
        name: e.name,
        status: e.status,
        outputBytes: e.outputBytes,
        exitCode: e.exitCode,
        at: e.at,
        rawStatus: parts[i].state?.status ?? "completed",
      });
    }

    if (!d.tokens) continue;
    const u = usageFromTokens(d.tokens);
    if (!d.error) {
      successSeen = true;
      prompts.push(u.prompt);
      if (u.prompt > maxContext) maxContext = u.prompt;
      if (u.reasoningTokens > 0) hasReasoning = true;
      if (at != null && (lastSuccessAt == null || at > lastSuccessAt)) lastSuccessAt = at;
    }
    if (turnCap > 0 && turns.length < turnCap) {
      turns.push({
        model_id: d.model?.id ?? null,
        duration_ms: d.time?.completed && d.time?.created ? d.time.completed - d.time.created : null,
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        reasoning_tokens: u.reasoningTokens,
        cache_read: u.cacheRead,
        cache_create: u.cacheCreate,
        cost_usd: d.cost != null ? Number(d.cost) || 0 : null,
        at,
      });
    }
  }

  const [latest] = errors;
  return {
    prompts: prompts.reverse(),
    maxContext,
    hasReasoning,
    lastSuccessAt,
    thinking,
    errors,
    standingError:
      latest && !latest.cleared ? { type: latest.type, message: latest.message, at: latest.at } : null,
    turns,
    toolCalls,
    // the detail panel's current-tool arguments: the newest call only, so a
    // large tool input (a file write) is stringified once per click, not per
    // tool block per poll
    lastToolInput: newestPart ? toolInput(newestPart, TOOL_INPUT_CAP) : null,
  };
}
