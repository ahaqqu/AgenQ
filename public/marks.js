// AgenQ derived marks — the board's iconography, derived from telemetry
// rather than from a table. Roles are project-invented (zcode reports the
// profile a subagent ran under, DSH reports the generic "subagent", and every
// project renames and retires its own) and harnesses are open-ended, so
// neither may be hardcoded client-side: a role's mark is its own initials in a
// hue hashed from the whole name, a harness's is its first letter in its own
// accent. A role or harness the board has never seen renders right with no
// client edit.
//
// Pure: this file touches no DOM. The frontend has no bundler by design, so it
// is loaded as a plain <script> (before visuals.js) and publishes one API
// object twice — as bare globals, which is how the four classic-script
// consumers (app.js, stats.js, conversation.js, detail.js) call it, and as
// globalThis.MARKS, the named boundary public/marks.test.mjs imports. Both
// come from the same object, so there is one thing to keep in step. The
// markup builders need escaping, so `esc` lives here with them (not with
// visuals.js's formatting helpers) and this module stays importable on its own.

(function () {
  // telemetry is untrusted text: everything a mark renders, or echoes into a
  // tooltip, goes through here
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // stable hue per string: a known harness id pins its hand-picked one,
  // everything else (any other harness, every role) hashes to the same value
  // on every load — no table to go stale. Coerces, because the value comes
  // from telemetry: a malformed role must not throw inside render()
  function hashHue(str) {
    const s = String(str ?? "");
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 360;
    return x;
  }
  // one accent recipe for every derived mark (harness letters and role pills):
  // hue-tinted text, border and background, so the two read as one family
  function markStyle(hue) {
    return `color:hsl(${hue} 85% 74%);border-color:hsl(${hue} 55% 46%);background:hsl(${hue} 75% 60% / .15)`;
  }

  // ---------- role marks ----------
  // the initials of the role's first words (up to three), so two roles sharing
  // a prefix (thermo-nuclear-review-subagent vs. …-code-quality-…) stay
  // distinguishable; non-ASCII role names keep their own letters
  function roleMonogram(role) {
    const words = String(role ?? "").split(/[^\p{L}\p{N}]+/u).filter((w) => /^\p{L}/u.test(w));
    if (!words.length) return "?";
    return words.slice(0, 3).map((w) => w[0].toUpperCase()).join("");
  }
  function roleStyle(role) {
    return markStyle(hashHue(role));
  }
  // a main session carries no role — 🧑‍✈️ is the board's own "the one you talked to"
  const MAIN_ICON = "🧑‍✈️";
  // Accepts a session object (uses its `role` field) or a bare role string;
  // returns the full badge markup, or the main-session icon when there is no
  // role. The string is coerced once here, so every part of the badge (hue,
  // monogram, tooltip) sees the same value whatever telemetry carried.
  function roleMark(s) {
    const role = String(typeof s === "string" ? s : (s?.role ?? ""));
    if (!role) return MAIN_ICON;
    return `<span class="rmark" style="${roleStyle(role)}" title="role: ${esc(role)}">${esc(roleMonogram(role))}</span>`;
  }

  // ---------- harness marks ----------
  // the letter is derived from the harness id (zcode → Z, hermes → H,
  // deepseek → D), so any future adapter gets a mark with no map and no client
  // edit. One identical mark on every surface — no label variant; the full
  // harness name lives in the tooltip and the legend. Each mark carries a
  // per-harness accent (letter, border, faint tint) so harnesses are
  // distinguishable at a glance: known ids get a hand-picked hue, anything
  // else a stable one hashed from the id.
  // Accepts a session object (uses its `harness` field), a bare harness id
  // (ticker entries), or null.
  const HARNESS_HUE = { "zcode": 212, "hermes": 26, "deepseek": 265 };
  function harnessHue(id) {
    return HARNESS_HUE[id] ?? hashHue(id);
  }
  function harnessStyle(h) {
    return markStyle(harnessHue(h));
  }
  function harnessMark(s) {
    const h = String(typeof s === "string" ? s : (s?.harness ?? ""));
    if (!h) return "";
    return `<span class="hmark" style="${harnessStyle(h)}" title="harness: ${esc(h)}">${esc(h.charAt(0).toUpperCase())}</span>`;
  }

  // the API: bare globals for the client (published as properties, so this file
  // adds no declaration to the scope these classic scripts share) and
  // globalThis.MARKS for the test
  const api = {
    esc, hashHue,
    harnessHue, harnessStyle, harnessMark,
    roleMonogram, roleStyle, roleMark,
  };
  Object.assign(globalThis, api);
  globalThis.MARKS = api;
})();
