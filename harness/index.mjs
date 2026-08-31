// AgenQ harness registry (see README.md in this directory for the contract).
//
// Every harness adapter mounts here. The registry is the single place that:
// - merges per-harness snapshots into the board's one snapshot
// - namespaces session ids (`<harnessId>:<rawId>`) so two harnesses can never
//   collide, and maps tree edges (parentId / children / roots) across
// - routes the lazy per-session endpoints (detail, messages) and the stop
//   action to the adapter that owns the session id
//
// The server (monitor.mjs) talks ONLY to this module; an adapter talks only
// to its own telemetry.
import zcode from "./zcode/index.mjs";
import hermes from "./hermes/index.mjs";

const ADAPTERS = [zcode, hermes];

const byId = new Map(ADAPTERS.map((a) => [a.id, a]));

const HARNESS_RE = /^([a-z0-9_-]+):(.+)$/s;

/** Split a namespaced id into { harnessId, rawId }, or null if unnamespaced. */
export function splitSessionId(nsId) {
  const m = HARNESS_RE.exec(nsId);
  return m ? { harnessId: m[1], rawId: m[2] } : null;
}

function adapterFor(nsId) {
  const s = splitSessionId(nsId);
  return s ? byId.get(s.harnessId) ?? null : null;
}

// Wrap/unwrap one session id across the registry boundary.
const nsId = (harnessId, rawId) => `${harnessId}:${rawId}`;
const rawId = (nsId_) => splitSessionId(nsId_)?.rawId ?? nsId_;

// Namespaces tree edges and origin fields on one session object. Session
// ids are the only cross-harness references in the snapshot shape.
function namespaceSession(harnessId, s) {
  return {
    ...s,
    id: nsId(harnessId, s.id),
    parentId: s.parentId ? nsId(harnessId, s.parentId) : null,
    harness: harnessId,
    children: (s.children ?? []).map((c) => nsId(harnessId, c)),
  };
}

// Merge every adapter's snapshot into the board's single snapshot shape.
// Per-harness failures degrade to an empty harness with a warning — a
// broken or uninstalled harness must never blank the whole board.
export async function snapshot(now = Date.now()) {
  const sessions = [];
  const harnesses = [];
  const tickers = [];
  const warnings = [];

  for (const adapter of ADAPTERS) {
    try {
      const snap = await adapter.snapshot(now);
      sessions.push(...snap.sessions.map((s) => namespaceSession(adapter.id, s)));
      if (snap.ticker?.length) tickers.push(...snap.ticker.map((t) => ({ ...t, sessionId: nsId(adapter.id, t.sessionId) })));
      if (snap.liveProcs) {
        // namespaces live-proc directories too — stop requests address them
        // by directory, and directory shapes may differ per harness
        harnesses.push({
          id: adapter.id,
          label: adapter.label,
          hasStop: adapter.hasStop === true,
          liveProcs: snap.liveProcs,
        });
      } else {
        harnesses.push({ id: adapter.id, label: adapter.label, hasStop: adapter.hasStop === true, liveProcs: {} });
      }
    } catch (e) {
      warnings.push(`${adapter.id}: ${e?.message ?? String(e)}`);
      harnesses.push({ id: adapter.id, label: adapter.label, hasStop: adapter.hasStop === true, liveProcs: {} });
    }
  }

  const byIdAll = new Map(sessions.map((s) => [s.id, s]));

  // roots: sessions whose parent is missing from the merged map — computed
  // here so a parent that lives in another harness (or was windowed out)
  // still anchors its subtree correctly
  const roots = sessions
    .filter((s) => !s.parentId || !byIdAll.has(s.parentId))
    .map((s) => s.id);

  // global ticker: prefer harness-provided tickers (richer tool history);
  // fall back to per-session lastTool entries when a harness offers none
  const ticker = (tickers.length
    ? tickers
    : sessions.flatMap((s) => (s.lastTool ? [{ sessionId: s.id, ...s.lastTool }] : [])))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 15);

  const totals = sessions.reduce(
    (acc, n) => ({
      inputTokens: acc.inputTokens + (n.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (n.outputTokens ?? 0),
      requests: acc.requests + (n.requests ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, requests: 0 },
  );

  return {
    generatedAt: now,
    windowHours: Math.max(...ADAPTERS.map((a) => a.cfg?.windowHours ?? 12)),
    harnesses,
    totals,
    liveProcs: Object.fromEntries(harnesses.flatMap((h) => Object.entries(h.liveProcs ?? {}))),
    warnings,
    sessions,
    roots,
    ticker,
  };
}

// Lazy per-session detail. Falls back to null when the owning harness does
// not offer detail (the UI hides the panel).
export function sessionDetail(nsId_) {
  const adapter = adapterFor(nsId_);
  if (!adapter?.detail) return null;
  return adapter.detail(rawId(nsId_));
}

// Cursor-resumable conversation for one namespaced session id.
export async function sessionMessages(nsId_, after) {
  const adapter = adapterFor(nsId_);
  if (!adapter) return null;
  return adapter.messages(rawId(nsId_), after);
}

// Stop dispatch. The server validates the target directory against the last
// snapshot (no arbitrary-kill surface); the adapter does the harness-native
// stop. Returns { harnessId, ...adapterResult }.
export async function stopRun(nsId_, directory, { sessions }) {
  const adapter = adapterFor(nsId_);
  if (!adapter?.hasStop || !adapter.stopRun) {
    return { error: `harness '${splitSessionId(nsId_)?.harnessId}' does not support stopping` };
  }
  const result = await adapter.stopRun(directory, { sessions });
  if (result?.error) return result;
  return { harnessId: adapter.id, ...result };
}