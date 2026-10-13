// OpenCode session-row counters. Per-message usage folds with the shared
// `usageFromTokens` in ../lib.mjs (same wire shape as the other adapters);
// only the cumulative on-row mapping is opencode-specific.
//
// Totals come from here rather than from summing messages, so a card's
// numbers do not depend on how many message rows one poll happened to walk.
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
