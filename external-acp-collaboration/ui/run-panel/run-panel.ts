/**
 * UI adapter boundary. The MCP server can expose this HTML as a resource, but
 * no Codex-specific UI metadata is declared because the documented plugin
 * manifest does not currently define a custom embedded panel surface.
 */
export function renderRunPanel(run: Record<string, unknown>): string {
  const status = escape(String(run.status ?? "unknown"));
  const runId = escape(String(run.id ?? run.runId ?? ""));
  const elapsed = escape(String(run.elapsedMs ?? ""));
  const activity = escape(String(run.lastActivity ?? "Waiting for provider updates"));
  const files = Array.isArray(run.changedFiles) ? run.changedFiles : [];
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>External ACP run</title></head>
<body>
  <section data-external-acp-run="${runId}">
    <h2>External ACP collaboration</h2>
    <p>Status: ${status} · Elapsed: ${elapsed}ms</p>
    <p>${activity}</p>
    <h3>Changed files</h3>
    <ul>${files.map((file) => `<li>${escape(JSON.stringify(file))}</li>`).join("")}</ul>
  </section>
</body></html>`;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
