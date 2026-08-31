#!/usr/bin/env bun
/**
 * AgenQ — live mission-control monitor for AI coding-agent sessions.
 *
 * Harness-agnostic core: every supported harness (ZCode today, Hermes next)
 * mounts as an adapter in harness/index.mjs and teaches the monitor where its
 * telemetry lives and how to read it. This file knows nothing about any
 * specific harness — it is pure HTTP plumbing over the registry:
 *
 *   GET  /api/state                          merged board snapshot
 *   GET  /api/session/:id/detail             lazy per-session detail (optional per harness)
 *   GET  /api/session/:id/messages?after=…   cursor-resumable conversation feed
 *   POST /api/stop                           harness stop action, project-level
 *
 * Read-only by construction: adapters open telemetry with mode=ro and only
 * ever list and read. The single deliberate exception is the stop action —
 * an explicit, user-clicked "stop run". Stop targets are validated against
 * the last snapshot, and the server binds 127.0.0.1 only.
 *
 *   bun monitor.mjs [--port 8787] [--window-hours 12] [--db …] [--agents-dir …]
 * (Harness-specific flags are defined in harness/<id>/config.mjs.)
 */
import { join } from "node:path";
import {
  snapshot,
  sessionDetail,
  sessionMessages,
  stopRun,
  splitSessionId,
} from "./harness/index.mjs";
import { listenerPidOnPort, killAndWait } from "./harness/zcode/proccontrol.mjs";

// ---------- server ----------

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

let lastGood = null;
let lastError = null;

// CSRF: a POST this consequential must be same-origin or direct curl use.
// Browsers always send Origin on cross-origin POSTs; curl sends neither
// header, which is why absence of both is also accepted.
function csrfOk(req, port) {
  const origin = req.headers.get("origin");
  const contentType = req.headers.get("content-type") ?? "";
  if (origin && !origin.startsWith(`http://127.0.0.1:${port}`) && origin !== `http://localhost:${port}`) {
    return false;
  }
  return contentType.includes("application/json");
}

// Resolve the stop target from the request against the last snapshot:
// { directory, project } | { error, status }.
function resolveStopTarget(body) {
  if (!lastGood) return { error: "no snapshot yet — poll /api/state first", status: 400 };
  // the target can be a namespaced session id or a directory
  let directory = typeof body?.directory === "string" ? body.directory : null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
  if (!directory && sessionId) {
    directory = lastGood.sessions.find((x) => x.id === sessionId)?.directory ?? null;
  }
  if (!directory) return { error: "unknown session or directory", status: 400 };
  // only directories AgenQ actually saw in telemetry are valid targets —
  // the stop action must never become an arbitrary process-kill surface
  const known = new Set(lastGood.sessions.map((x) => x.directory).filter(Boolean));
  if (!known.has(directory)) {
    return { error: `directory not known to AgenQ: ${directory}`, status: 400 };
  }
  const project = lastGood.sessions.find((x) => x.directory === directory)?.project ?? directory;
  return { directory, project };
}

function startServer(port) {
  return Bun.serve({
    port,
    // the stop action makes this no longer harmless to expose — loopback only
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/stop" && req.method === "POST") {
        try {
          if (!csrfOk(req, port)) {
            return Response.json({ error: "cross-origin or non-JSON stop requests are not allowed" }, { status: 403 });
          }
          const body = await req.json().catch(() => null);
          const target = resolveStopTarget(body);
          if (target.error) {
            return Response.json({ error: target.error, killed: [] }, { status: target.status });
          }
          // find the harness that owns the target and let it stop the run
          const sessionId = body?.sessionId ?? lastGood.sessions.find((x) => x.directory === target.directory)?.id;
          const own = sessionId ? splitSessionId(sessionId)?.harnessId : null;
          const harness = own
            ? lastGood.harnesses.find((h) => h.id === own)
            : null;
          if (harness && !harness.hasStop) {
            return Response.json({ error: `harness '${harness.id}' does not support stopping` }, { status: 400 });
          }
          const result = await stopRun(sessionId ?? target.directory, target.directory, {
            sessions: lastGood.sessions,
          });
          if (result?.error) {
            return Response.json(result, { status: 400 });
          }
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: String(e?.message ?? e), killed: [] }, { status: 500 });
        }
      }
      const detail = url.pathname.match(/^\/api\/session\/([^/]+)\/detail$/);
      if (detail && req.method === "GET") {
        try {
          const d = sessionDetail(decodeURIComponent(detail[1]));
          if (!d) return Response.json({ error: "no detail for this session" }, { status: 404 });
          return Response.json(d);
        } catch (e) {
          return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
        }
      }
      const msgs = url.pathname.match(/^\/api\/session\/([^/]+)\/messages$/);
      if (msgs && req.method === "GET") {
        try {
          const m = await sessionMessages(decodeURIComponent(msgs[1]), url.searchParams.get("after"));
          if (!m) return Response.json({ error: "unknown session or harness" }, { status: 404 });
          return Response.json(m);
        } catch (e) {
          return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
        }
      }
      if (url.pathname === "/api/state") {
        try {
          lastGood = await snapshot();
          lastError = null;
          return Response.json(lastGood);
        } catch (e) {
          lastError = String(e?.message ?? e);
          console.error("snapshot failed:", e?.stack ?? lastError);
          return Response.json(
            { ...(lastGood ?? { sessions: [], roots: [], totals: { inputTokens: 0, outputTokens: 0, requests: 0 }, ticker: [], harnesses: [] }), pollError: lastError },
            { status: lastGood ? 200 : 503 },
          );
        }
      }
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = Bun.file(join(import.meta.dir, "public", rel));
      if (await file.exists()) {
        const ext = "." + rel.split(".").pop();
        return new Response(file, {
          headers: {
            "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
            // the UI is a dev tool that changes often — never let the browser
            // serve a stale board from heuristic caching
            "cache-control": "no-cache",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

// Server-own flags only (--port). Harness telemetry flags (--db, --agents-dir)
// are defined and parsed by each harness's config.mjs.
const PORT = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8787;

try {
  startServer(PORT);
} catch (e) {
  if (!String(e?.code ?? e?.message).includes("EADDRINUSE")) throw e;
  const pid = listenerPidOnPort(PORT);
  if (!pid) {
    console.error(`port ${PORT} is already in use — and not by a restartable AgenQ instance.`);
    console.error(`  find it: ss -ltnp | grep ${PORT}   or pick another: agenq --port ${PORT + 1}`);
    process.exit(1);
  }
  console.log(`restarting AgenQ (stopping pid ${pid}) …`);
  killAndWait(pid);
  try {
    startServer(PORT);
  } catch {
    console.error(`port ${PORT} still unavailable after stopping pid ${pid}.`);
    process.exit(1);
  }
}

console.log(`AgenQ monitor → http://localhost:${PORT}`);