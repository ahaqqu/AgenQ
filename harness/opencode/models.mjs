// OpenCode's model catalog -> the real context window a card measures against.
//
// opencode caches models.dev's catalog in its `kv` table under
// `models-dev:catalog`: `{ updatedAt, digest, body }`, where `body` is a JSON
// string of providers -> models -> `limit.context`. That is the one place this
// harness records a model's real window, so an OpenCode card can draw its
// cliff where the model actually breaks instead of at the UI's 200k
// fallback (the same optional row DeepSeek Harness fills).
//
// The body is ~5 MB, so it is read and parsed at most once per TTL and kept
// as a flat `provider|model -> context` map; the rest of the catalog is
// dropped.
import { rows } from "./db.mjs";

const CATALOG_KEY = "models-dev:catalog";
const TTL_MS = 10 * 60_000;
const SEP = "|";

export const modelKey = (provider, model) => `${provider ?? ""}${SEP}${model ?? ""}`;

let cache = { at: 0, map: null, failed: false };

function build(body) {
  const providers = typeof body === "string" ? JSON.parse(body) : body;
  const map = new Map();
  for (const [pid, prov] of Object.entries(providers ?? {})) {
    for (const [mid, model] of Object.entries(prov?.models ?? {})) {
      const ctx = model?.limit?.context;
      if (typeof ctx === "number" && ctx > 0) map.set(modelKey(pid, mid), ctx);
    }
  }
  return map;
}

/**
 * provider/model -> context window for every model the catalog knows.
 * Returns a possibly empty map and never throws: a harness without the
 * `kv` table, or a catalog it cannot parse, simply keeps the 200k fallback.
 */
export function loadContextWindows(db, { now = Date.now(), ttlMs = TTL_MS } = {}) {
  if (cache.map && now - cache.at < ttlMs) return cache.map;
  if (cache.failed && now - cache.at < ttlMs) return cache.map ?? new Map();

  let row;
  try {
    row = rows(db, `SELECT value FROM kv WHERE key = ?`, [CATALOG_KEY])[0];
  } catch {
    // no kv table (an install predating it) — remember and back off
    cache = { at: now, map: cache.map ?? new Map(), failed: true };
    return cache.map;
  }
  if (!row?.value) {
    cache = { at: now, map: cache.map ?? new Map(), failed: true };
    return cache.map;
  }
  try {
    const parsed = JSON.parse(row.value);
    cache = { at: now, map: build(parsed.body), failed: false };
  } catch {
    // a catalog we cannot read is not worth re-reading every poll
    cache = { at: now, map: cache.map ?? new Map(), failed: true };
  }
  return cache.map;
}

/** Test seam: forget the parsed catalog. */
export function resetCatalog() {
  cache = { at: 0, map: null, failed: false };
}
