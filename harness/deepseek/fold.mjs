// DSH event -> board aggregate. The only harness-domain module: it knows the
// event vocabulary DSH persists and nothing about files, frames or caching.
// `foldEvent` is pure — it mutates the aggregate it is handed and *returns*
// the conversation record the event produces (or null), so the reader decides
// whether records are being collected.
import { CONV_INPUT_CAP, CONV_TEXT_CAP, CONV_THINK_CAP, head, tail } from "../lib.mjs";

export const SPARK_TAIL = 120; // sparkline points kept per agent
export const CALLS_TAIL = 150; // tool calls kept per agent (ticker + in-flight status)
export const RECENT_USAGE = 5; // model calls kept for the detail panel's turn rows
export const RECENT_ERRORS = 3;
const THINK_TAIL = 600;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** A fresh aggregate; `header` seeds the fields a log header already answers. */
export function newAgg(header = null) {
  return {
    header,
    title: null,
    model: null, // { provider, model } of the most recent model call
    thinking: null, // reasoning effort
    contextWindow: null,
    subagent: null, // descriptor of a subagent session ({mode, provider, label})
    requests: 0,
    inputTokens: 0, // prompt tokens including cache reads (board semantics)
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    reasoningTokens: 0,
    maxContext: 0, // biggest single-request prompt
    sparkline: [],
    firstAt: header ? num(header.createdAt) : null,
    lastAt: 0,
    lastSeq: -1,
    lastError: null,
    lastOkAt: 0,
    lastTurnEnd: null,
    todos: [],
    calls: new Map(), // callId -> { callId, name, input, at, status, outputBytes, exitCode }
    lastThinking: null,
    recentUsage: [],
    recentErrors: [],
    stepStart: null,
  };
}

// text length + trailing text of a tool result, without concatenating a
// potentially huge result body (a `read` of a big file can be megabytes)
function contentStats(content) {
  let bytes = 0;
  let last = "";
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === "string") {
        bytes += part.text.length;
        last = part.text;
      }
    }
  }
  return { bytes, last };
}

const textOfBlocks = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");

// Bash results end with one of DSH's own outcome markers; a clean exit carries
// none, so "no marker" is a success, not unknown (dsh-tool-bash/render).
const EXIT_RE = /(?:^|\n)\[exit code: (\d+)\]\s*$/;
const SIGNAL_RE = /(?:^|\n)\[killed by signal: ([A-Za-z0-9_]+)\]\s*$/;
const TIMEOUT_RE = /(?:^|\n)\[timed out after (\d+)ms\]\s*$/;

function bashOutcome(text) {
  const tailText = text.slice(-200);
  return {
    exitCode: Number(EXIT_RE.exec(tailText)?.[1] ?? NaN) || null,
    signal: SIGNAL_RE.exec(tailText)?.[1] ?? null,
    timedOutMs: Number(TIMEOUT_RE.exec(tailText)?.[1] ?? NaN) || null,
  };
}

function pushError(agg, err) {
  agg.lastError = err;
  agg.recentErrors.unshift(err);
  if (agg.recentErrors.length > RECENT_ERRORS) agg.recentErrors.length = RECENT_ERRORS;
}

/**
 * Fold one persisted event into the aggregate and return the conversation
 * record it produced (or null). Records are self-contained: a chip rendering
 * later needs nothing from the aggregate, so the two caches can never drift.
 */
export function foldEvent(agg, ev) {
  const type = ev?.type;
  if (typeof type !== "string") return null;
  const time = num(ev.time);
  if (time > agg.lastAt) agg.lastAt = time;
  if (Number.isFinite(ev.seq) && ev.seq > agg.lastSeq) agg.lastSeq = ev.seq;
  const d = ev.data ?? {};
  const at = time;
  const seq = agg.lastSeq;

  switch (type) {
    case "session":
      if (!agg.header) {
        agg.header = ev;
        if (agg.firstAt == null) agg.firstAt = num(ev.createdAt) || time;
      }
      return null;

    case "session/title":
      if (d.title) agg.title = String(d.title);
      return null;

    case "model/selection":
      agg.model = { provider: d.provider ?? null, model: d.model ?? null };
      agg.thinking = d.reasoningEffort ?? null;
      return null;

    case "request/header": {
      // the config a request actually ran with — the most precise model +
      // reasoning-effort source (covers subagents too)
      const c = d.header?.config;
      if (c?.model) {
        agg.model = { provider: c.provider ?? null, model: c.model };
        agg.thinking = c.reasoningEffort ?? null;
      }
      return null;
    }

    case "request/context":
      if (d.contextWindow) agg.contextWindow = num(d.contextWindow);
      return null;

    case "step/start":
      agg.stepStart = { turn: d.turn, step: d.step, at };
      return null;

    case "subagent/descriptor":
      agg.subagent = { mode: d.mode ?? null, provider: d.provider ?? null, label: d.label ?? null };
      return null;

    case "todo/write":
      agg.todos = (Array.isArray(d.todos) ? d.todos : []).map((x) => ({
        content: String(x?.content ?? ""),
        status: x?.status === "completed" ? "done" : String(x?.status ?? "pending"),
      }));
      return null;

    case "assistant/message": {
      const usage = d.usage ?? {};
      const prompt = num(usage.inputTokens) + num(usage.cacheReadTokens);
      // a model call the provider billed nothing for (an aborted or empty
      // response) is still a request, but a 0-token sparkline point and a
      // 0/0 turn row would be noise, so the counters only move when the log
      // actually measured the call
      const measured =
        usage.inputTokens != null || usage.outputTokens != null ||
        usage.cacheReadTokens != null || usage.reasoningTokens != null;
      agg.requests += 1;
      if (measured) {
        agg.inputTokens += prompt;
        agg.outputTokens += num(usage.outputTokens);
        agg.cacheRead += num(usage.cacheReadTokens);
        agg.cacheCreate += num(usage.cacheWriteTokens);
        agg.reasoningTokens += num(usage.reasoningTokens);
        if (prompt > agg.maxContext) agg.maxContext = prompt;
        agg.sparkline.push(prompt);
        if (agg.sparkline.length > SPARK_TAIL) agg.sparkline.shift();
      }
      agg.lastOkAt = Math.max(agg.lastOkAt, at);

      const src = d.message?.source;
      if (src?.model) agg.model = { provider: src.provider ?? null, model: src.model };

      const step = agg.stepStart;
      const inStep = step && step.turn === d.turn && step.step === d.step;
      if (measured) {
        agg.recentUsage.unshift({
          turn: d.turn ?? null,
          step: d.step ?? null,
          model_id: src?.model ?? agg.model?.model ?? null,
          started_at: inStep ? step.at : null,
          duration_ms: inStep ? Math.max(0, at - step.at) : null,
          // the board's input semantics: prompt tokens including cache reads
          input_tokens: prompt,
          output_tokens: num(usage.outputTokens),
          reasoning_tokens: num(usage.reasoningTokens),
          cache_read_input_tokens: num(usage.cacheReadTokens),
          cache_creation_input_tokens: num(usage.cacheWriteTokens),
        });
        if (agg.recentUsage.length > RECENT_USAGE) agg.recentUsage.length = RECENT_USAGE;
      }

      const blocks = [];
      for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (b?.type === "text" && b.text) blocks.push({ type: "text", text: head(b.text, CONV_TEXT_CAP) });
        else if (b?.type === "reasoning" && b.text) {
          blocks.push({ type: "reasoning", text: tail(b.text, CONV_THINK_CAP) });
          agg.lastThinking = { text: tail(b.text, THINK_TAIL), at };
        }
      }
      return { seq, at, kind: "assistant", blocks };
    }

    case "user/message": {
      // DSH commits injected content (workspace instructions, skill catalogs,
      // runtime context, job notices) through the same event type with a
      // source discriminator. The live conversation is a human view, so only
      // what the human actually said is rendered as "you".
      if (d.source?.kind !== "user") return null;
      return { seq, at, kind: "user", text: head(textOfBlocks(d.content), CONV_TEXT_CAP) };
    }

    case "tool/call": {
      const callId = d.callId;
      if (!callId) return null;
      const info = {
        callId,
        name: d.name ?? "?",
        input: d.arguments ? head(d.arguments, CONV_INPUT_CAP) : null,
        at,
        status: null,
        outputBytes: null,
        exitCode: null,
      };
      agg.calls.set(callId, info);
      if (agg.calls.size > CALLS_TAIL) agg.calls.delete(agg.calls.keys().next().value);
      return { seq, at, kind: "call", callId, name: info.name, input: info.input };
    }

    case "tool/result": {
      const msg = d.message ?? {};
      const block = msg.content?.[0] ?? {};
      const callId = msg.source?.callId ?? block.toolCallId ?? null;
      const isError = block.isError === true || d.error != null;
      const { bytes, last } = contentStats(block.content);
      const outcome = bashOutcome(last);
      const failed = isError || outcome.signal != null || outcome.timedOutMs != null;
      const info = callId ? agg.calls.get(callId) : null;
      if (info) {
        info.status = failed ? "error" : "completed";
        info.outputBytes = bytes;
        info.exitCode = outcome.exitCode;
      }
      if (!callId) return null;
      return {
        seq,
        at,
        kind: "result",
        callId,
        name: info?.name ?? null,
        input: info?.input ?? null,
        isError: failed,
        outputBytes: bytes,
      };
    }

    case "turn/end": {
      const reason = d.reason ?? {};
      const kind = reason.kind ?? "unknown";
      agg.lastTurnEnd = { kind, at };
      agg.stepStart = null;
      // a completed or user-aborted turn is a clean end: an older transient
      // error (a rate limit that was retried away) must not mark it failed
      if (kind === "completed" || kind === "aborted") agg.lastOkAt = Math.max(agg.lastOkAt, at);
      if (kind === "error") {
        pushError(agg, {
          type: reason.error?.code ?? "turn_error",
          message: reason.error?.message ?? "turn failed",
          at,
        });
      }
      return null;
    }

    case "llm/retry": {
      // a retry is where rate limits and transport failures surface; it stays
      // visible until a later model call or completed turn proves recovery
      const f = d.failure ?? {};
      pushError(agg, {
        type: f.code ?? "llm_retry",
        message: f.message ?? "model call failed",
        at,
      });
      return null;
    }

    default:
      return null; // every other event type is scaffolding for the board
  }
}

// An error is only news until the session proves it recovered (zcode's rule).
// The row, the failure panel and the feed all read this one answer.
export const visibleError = (agg) =>
  agg.lastError && !(agg.lastOkAt && agg.lastError.at <= agg.lastOkAt) ? agg.lastError : null;
