// Shared token mapping for the OpenCode DB.
// Wire shape (assistant `session_message.data.tokens`):
//   { input, output, reasoning, cache: { read, write } }
// `input` excludes cache reads (opencode records them in `cache.read` alone —
// a session row's `tokens_input` sits at ~3.4M next to `tokens_cache_read`
// at ~207M for the same run). The board's `inputTokens` includes the cached
// part so cache-hit% = cacheRead / inputTokens stays in [0, 1], the same
// fold the other adapters apply.
export function usageFromTokens(tokens) {
  const t = tokens ?? {};
  const cache = t.cache ?? {};
  const input = Number(t.input) || 0;
  const cacheRead = Number(cache.read) || 0;
  const cacheCreate = Number(cache.write) || 0;
  const output = Number(t.output) || 0;
  return {
    inputTokens: input + cacheRead,
    outputTokens: output,
    cacheRead,
    cacheCreate,
    reasoningTokens: Number(t.reasoning) || 0,
    prompt: input + cacheRead,
    total: Number(t.total) || input + cacheRead + output + Number(t.reasoning || 0) + cacheCreate,
  };
}

/**
 * Cumulative counters kept on the session row itself. Totals come from here
 * rather than from summing messages, so a card's numbers do not depend on how
 * many message rows one poll happened to walk.
 */
export function usageFromSessionColumns(s) {
  const input = Number(s.tokens_input) || 0;
  const cacheRead = Number(s.tokens_cache_read) || 0;
  return {
    inputTokens: input + cacheRead,
    outputTokens: Number(s.tokens_output) || 0,
    cacheRead,
    cacheCreate: Number(s.tokens_cache_write) || 0,
    reasoningTokens: Number(s.tokens_reasoning) || 0,
  };
}
