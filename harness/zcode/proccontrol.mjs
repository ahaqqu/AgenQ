// Process control: the single-instance restart logic and the one deliberate
// write path AgenQ has — POST /api/stop, a user-clicked "stop run" that
// SIGTERMs every zcode-cli process whose cwd matches a project directory.
// Process correlation is project-level by nature, so the action is offered
// and labeled as project-level in the UI.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { gatherLiveProcs } from "./snapshot.mjs";

// ---------- single instance: running `agenq` again restarts it ----------

// The port holder is identified via /proc/net/tcp socket inodes; only a
// process whose command line is AgenQ itself is ever a restart target.
function isMonitorCmdline(cmd) {
  return cmd.split("\0").some(
    (a) => a === "agenq" || a.endsWith("/agenq") || a === "monitor.mjs" || a.endsWith("/monitor.mjs"),
  );
}

export function listenerPidOnPort(port) {
  const inodes = new Set();
  const hexPort = port.toString(16).padStart(4, "0").toUpperCase();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // sl local_address rem_address st … inode
      if (cols.length < 10 || cols[3] !== "0A" /* LISTEN */) continue;
      if (cols[1]?.split(":")[1] !== hexPort) continue;
      inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return null;
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${e}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let tgt;
      try {
        tgt = readlinkSync(`/proc/${e}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = tgt.match(/^socket:\[(\d+)\]$/);
      if (!m || !inodes.has(m[1])) continue;
      try {
        if (!isMonitorCmdline(readFileSync(`/proc/${e}/cmdline`, "utf8"))) return null;
      } catch {
        return null;
      }
      return Number(e); // a real AgenQ holds the port
    }
  }
  return null; // port held by something that isn't AgenQ
}

export function killAndWait(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      readFileSync(`/proc/${pid}/stat`);
    } catch {
      return; // gone
    }
    Bun.sleepSync(50);
  }
  console.log(`  pid ${pid} ignored SIGTERM — sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

// Stop a project run: SIGTERM every zcode-cli process whose cwd is
// `directory`. Directory validation (is it a project AgenQ actually saw?)
// belongs to the caller — the server checks it against the last snapshot
// before dispatching, so an adapter is never an attack surface for arbitrary
// process kills. Returns { killed, directory, project }; throws if no live
// CLI process exists for the directory.
export function stopRun(directory, { sessions }) {
  const project = sessions.find((x) => x.directory === directory)?.project ?? directory;
  const pids = gatherLiveProcs().get(directory) ?? [];
  if (!pids.length) {
    throw new Error(`no live zcode-cli process in ${directory} — run already exited`);
  }
  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (e) {
      console.error(`SIGTERM ${pid} failed:`, e.message);
    }
  }
  console.log(`stop: SIGTERM ${killed.join(", ")} (${directory}) — project ${project}`);
  return { killed, directory, project };
}