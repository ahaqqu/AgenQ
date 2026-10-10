// Shared token mapping for the MiMoCode trajectory DB.
// Wire shape (assistant `message.data.tokens` and `step-finish` parts):
//   { total?, input, output, reasoning, cache: { read, write } }
// `input` excludes cache reads (Anthropic-style). The board's `inputTokens`
// includes the cached part so cache-hit% = cacheRead / inputTokens stays in
// [0, 1] — the same fold the DeepSeek adapter applies.
export function usageFromTokens(tokens) {
  const t = tokens ?? {};
  const cache = t.cache ?? {};
  const input = Number(t.input) || 0;
  const cacheRead = Number(cache.read) || 0;
  const cacheCreate = Number(cache.write) || 0;
  return {
    inputTokens: input + cacheRead,
    outputTokens: Number(t.output) || 0,
    cacheRead,
    cacheCreate,
    reasoningTokens: Number(t.reasoning) || 0,
    prompt: input + cacheRead,
    total: Number(t.total) || input + cacheRead + (Number(t.output) || 0) + (Number(t.reasoning) || 0) + cacheCreate,
  };
}
