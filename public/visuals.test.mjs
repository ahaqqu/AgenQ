// Pins the role-mark derivation — the rule that lets the board render any
// role a harness reports without a fixed role→icon table. Roles are
// telemetry (zcode profile ids today, whatever a project renames them to
// tomorrow), so the only thing that may be asserted here is that the mark
// follows the role's own name. Run: bun test
import { test, expect } from "bun:test";
import "./visuals.js";

const { roleMonogram, roleStyle, roleMark, hashHue } = globalThis.VISUALS;

test("a role's badge is its own initials, however many words it has", () => {
  expect(roleMonogram("implementer")).toBe("I");
  expect(roleMonogram("reviewer")).toBe("R");
});

test("multi-word roles take up to three initials", () => {
  expect(roleMonogram("senior-implementer")).toBe("SI");
  expect(roleMonogram("general-purpose")).toBe("GP");
  expect(roleMonogram("assistant-manager")).toBe("AM");
  expect(roleMonogram("thermo-nuclear-review-subagent")).toBe("TNR");
  // the case that matters: two roles whose first two words match must not
  // collapse into the same badge
  expect(roleMonogram("thermo-nuclear-code-quality-review-subagent")).toBe("TNC");
  expect(roleMonogram("thermo-nuclear-code-quality-review-subagent"))
    .not.toBe(roleMonogram("thermo-nuclear-review-subagent"));
});

test("namespace separators, casing and version digits don't leak into the badge", () => {
  expect(roleMonogram("documents:visual-judge")).toBe("DVJ");
  expect(roleMonogram("Explore")).toBe("E");
  expect(roleMonogram("gpt-5-codex")).toBe("GC");
  expect(roleMonogram("")).toBe("?");
  expect(roleMonogram(null)).toBe("?");
});

test("a hue is derived from the whole role string and is stable across loads", () => {
  expect(hashHue("implementer")).toBe(hashHue("implementer"));
  expect(hashHue("implementer")).toBeGreaterThanOrEqual(0);
  expect(hashHue("implementer")).toBeLessThan(360);
  // roles that share initials still differ: the hue covers the full string
  expect(hashHue("test-implementer")).not.toBe(hashHue("thermo-nuclear-review-subagent"));
  expect(roleStyle("reviewer")).toContain(`hsl(${hashHue("reviewer")}`);
});

test("every role gets a badge — known to the board or never seen before", () => {
  // the regression this file exists for: a role the client has no entry for
  // must render its own mark, not a generic fallback
  for (const role of ["general-purpose", "fixer", "Explore", "documents:visual-judge"]) {
    const html = roleMark({ role });
    expect(html).toContain(`>${roleMonogram(role)}<`);
    expect(html).toContain('class="rmark"');
  }
  // main sessions carry no role and keep the board's own icon
  expect(roleMark({ role: null })).not.toContain("rmark");
  expect(roleMark({})).toBe(roleMark(""));
});

test("the role string is escaped into the badge's tooltip", () => {
  const html = roleMark({ role: "<img src=x onerror=alert(1)>" });
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});
