import * as v from "valibot";

const NonEmptyString = v.pipe(v.string(), v.minLength(1));

const SessionFields = {
  session_id: v.optional(NonEmptyString),
  cwd: v.optional(v.string()),
};

const ToolFields = {
  tool_name: NonEmptyString,
  tool_use_id: v.optional(NonEmptyString),
  tool_input: v.optional(v.unknown()),
};

/**
 * ZCode workspace-hook stdin payloads, as delivered to `process` hooks
 * declared in `.zcode/config.json` (Claude-compatible envelope). Only the
 * three tool-lifecycle events the iteration-guardrail hook consumes are
 * modeled; unknown keys are ignored so the contract stays forward-compatible
 * with the runtime envelope.
 *
 * Failure semantics consumed by the guardrail:
 * - `PostToolUse.tool_response`: the tool's output object; for `Bash` it
 *   carries `status` and `exitCode` (typed as unknown here — the runtime
 *   owns that shape; the consumer narrows it defensively).
 * - `PostToolUseFailure.error`: the harness-level tool error.
 */
export const ZcodeHookPayloadSchema = v.variant("hook_event_name", [
  v.object({
    hook_event_name: v.literal("PreToolUse"),
    ...ToolFields,
    ...SessionFields,
  }),
  v.object({
    hook_event_name: v.literal("PostToolUse"),
    ...ToolFields,
    tool_response: v.optional(v.unknown()),
    ...SessionFields,
  }),
  v.object({
    hook_event_name: v.literal("PostToolUseFailure"),
    ...ToolFields,
    error: v.optional(v.object({ message: NonEmptyString })),
    is_interrupt: v.optional(v.boolean()),
    ...SessionFields,
  }),
]);

export type ZcodeHookPayload = v.InferOutput<typeof ZcodeHookPayloadSchema>;

export type ZcodeHookParseResult =
  | { ok: true; payload: ZcodeHookPayload }
  | { ok: false; reason: string };

/** Validate a raw hook payload. Never throws; `ok: false` means "not ours". */
export function parseZcodeHookPayload(raw: unknown): ZcodeHookParseResult {
  const result = v.safeParse(ZcodeHookPayloadSchema, raw);
  if (result.success) return { ok: true, payload: result.output };
  return {
    ok: false,
    reason: result.issues
      .map((issue) => `${issue.path?.map((p) => p.key).join(".") ?? "<root>"}: ${issue.message}`)
      .join("; "),
  };
}
