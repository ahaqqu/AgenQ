// Pins the zcode stats bucket contract under non-UTC timezones: the SQL names
// each row's LOCAL hour as a label, and lib.mjs's localKeyToMs turns that
// label into the bucket start the dashboard compares against. The bug this
// guards against (round-tripping the wall-clock string through strftime('%s',
// …), which reinterprets it as UTC and shifts every bucket by the host's
// offset) is invisible on a UTC machine, so each case runs the real adapter in
// a subprocess with TZ pinned.
// Run: bun test
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// one model_usage row at `startedAt`, with a session row to join against
function fixture(startedAt, directory = "/home/u/Projects/demo") {
  const dir = mkdtempSync(join(tmpdir(), "agenq-stats-"));
  dirs.push(dir);
  const db = new Database(join(dir, "db.sqlite"));
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER)`);
  db.run(`CREATE TABLE model_usage (
    session_id TEXT, provider_id TEXT, model_id TEXT, started_at INTEGER, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER)`);
  db.run(`INSERT INTO session VALUES ('s1', ?, NULL, ?, ?)`, [directory, startedAt, startedAt + 1000]);
  db.run(`INSERT INTO model_usage VALUES ('s1', 'prov', 'model', ?, ?, 100, 10, 5, 1)`, [startedAt, startedAt + 500]);
  db.close();
  return join(dir, "db.sqlite");
}

// Run the real adapter under a pinned TZ. TZ is read when Date formats, so it
// must be set before the process starts, not switched mid-test.
function statsUnder(tz, dbPath, startedAt) {
  const script = `
    const { stats } = await import(${JSON.stringify(new URL("./stats.mjs", import.meta.url).href)});
    const out = await stats({ db: ${JSON.stringify(dbPath)} });
    const { localHourKey, localHourStart, localKeyToMs } = await import(${JSON.stringify(new URL("../lib.mjs", import.meta.url).href)});
    const sqlLabel = (() => {
      const { Database } = require("bun:sqlite");
      const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
      const r = db.query("SELECT strftime('%Y-%m-%dT%H', ?/1000, 'unixepoch', 'localtime') AS b").get(${startedAt});
      db.close();
      return r.b;
    })();
    process.stdout.write(JSON.stringify({
      grain: out.grain,
      at: out.usage[0]?.at,
      requests: out.usage[0]?.requests,
      inputTokens: out.usage[0]?.inputTokens,
      project: out.usage[0]?.project,
      jsHourKey: localHourKey(${startedAt}),
      jsHourStart: localHourStart(${startedAt}),
      sqlLabel,
      sqlLabelToMs: localKeyToMs(sqlLabel),
    }));
  `;
  const p = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, TZ: tz },
    cwd: import.meta.dir,
  });
  if (p.exitCode !== 0) throw new Error(`subprocess failed (TZ=${tz}): ${p.stderr.toString()}`);
  return JSON.parse(p.stdout.toString());
}

// an instant with nonzero minutes, so a shifted bucket is unambiguous
const STARTED_AT = new Date(2026, 9, 4, 17, 43, 25).getTime();

for (const tz of ["UTC", "Asia/Jakarta", "America/New_York", "Europe/Berlin"]) {
  test(`the hour bucket is the true local hour start under TZ=${tz}`, () => {
    const out = statsUnder(tz, fixture(STARTED_AT), STARTED_AT);

    expect(out.grain).toBe("hour");
    // the SQL labels the local hour, and the label is the same one the DSH
    // fold produces — the two surfaces cannot disagree
    expect(out.sqlLabel).toBe(out.jsHourKey);
    // the adapter's bucket start is that label converted, with the minute and
    // second dropped, at the event's own local hour
    expect(out.at).toBe(out.jsHourStart);
    expect(out.at).toBe(out.sqlLabelToMs);
    const d = new Date(out.at);
    expect([d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0]);
    expect(d.getHours()).toBe(new Date(STARTED_AT).getHours());
    expect(d.getDate()).toBe(new Date(STARTED_AT).getDate());
    expect(out.requests).toBe(1);
    expect(out.inputTokens).toBe(100);
    expect(out.project).toBe("demo");
  });
}

test("an evening request stays on its own day — never shifts into the next", () => {
  // 23:30 local would become 06:30 the next day under the old +7h shift
  const late = new Date(2026, 9, 4, 23, 30, 0).getTime();
  const out = statsUnder("Asia/Jakarta", fixture(late), late);
  const d = new Date(out.at);
  expect(d.getDate()).toBe(4);
  expect(d.getHours()).toBe(23);
  // and it is not in the future
  expect(out.at).toBeLessThanOrEqual(late);
});
