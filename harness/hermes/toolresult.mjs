// Hermes tool-result interpretation, shared by snapshot (ticker/lastTool)
// and detail (current tool + conversation chips) so the verdict can't drift.
// One JSON.parse per result row; both callers consume the same verdict.

// Hermes result payloads are JSON objects like
//   {"output": "...", "exit_code": 0, "error": null, "success": true}
// A result is an error when the payload says so (error set, success false)
// or when the terminal reports a nonzero exit code. Non-JSON bodies (older
// hermes builds) completed by construction.
export function toolResult(content) {
  try {
    const d = JSON.parse(content);
    if (d != null && typeof d === "object") {
      const errored =
        d.error != null ||
        d.success === false ||
        (Number.isFinite(d.exit_code) && d.exit_code !== 0);
      return { status: errored ? "error" : "completed", exitCode: d.exit_code ?? null };
    }
  } catch {
    // non-JSON result body — treat as completed
  }
  return { status: "completed", exitCode: null };
}