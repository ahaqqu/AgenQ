// OpenCode message-part parsing: the content blocks an assistant
// `session_message.data` carries, in the shapes the board needs.
//
// A v2 assistant message looks like:
//   { time, agent, model, content: [ {type:"reasoning"|"text"|"tool", …} ],
//     tokens, cost, finish, error }
// and a tool block is:
//   { type:"tool", name, state:{ status, input, content, metadata },
//     time:{ created, ran, completed } }
// `state.content` holds the tool's own output (a string for bash/write, an
// array for read/grep); `state.metadata` carries `exit`/`truncated`.

/** the content array of a parsed message, always an array. */
export const contentParts = (data) => (Array.isArray(data?.content) ? data.content : []);

export const toolParts = (data) => contentParts(data).filter((p) => p?.type === "tool");

/** Tool output size in bytes — whatever the harness actually stored. */
function outputBytes(state) {
  const c = state?.content;
  if (typeof c === "string") return Buffer.byteLength(c);
  if (c != null) return Buffer.byteLength(JSON.stringify(c));
  const meta = typeof state?.metadata?.output === "string" ? state.metadata.output : null;
  return meta ? Buffer.byteLength(meta) : 0;
}

const STATUS_OK = (status) =>
  status === "completed" ? "ok" : status === "error" ? "error" : status ?? "ok";

/**
 * One tool call as the ticker / lastTool row wants it.
 * `atFallback` is the message's own timestamp — tool blocks sometimes carry
 * no completion time while they are still running.
 */
export function toolEntry(part, atFallback = null) {
  const state = part?.state ?? {};
  const time = part?.time ?? state.time ?? {};
  return {
    name: part?.name ?? "tool",
    status: STATUS_OK(state.status),
    outputBytes: outputBytes(state),
    exitCode: state.metadata?.exit ?? state.metadata?.exitCode ?? state.exitCode ?? null,
    at:
      time.completed ??
      time.end ??
      time.ran ??
      time.created ??
      state.time?.end ??
      atFallback,
  };
}

/** Plain text of a reasoning/text block, or "". */
export function partText(part) {
  if (!part) return "";
  const t = part.text;
  return typeof t === "string" ? t : "";
}

/** A tool block's arguments, as the detail panel / feed renders them. */
export function toolInput(part, cap) {
  const input = part?.state?.input;
  if (input == null) return null;
  const s = typeof input === "string" ? input : JSON.stringify(input);
  return cap != null && s.length > cap ? s.slice(0, cap) : s;
}
