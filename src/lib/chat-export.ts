/**
 * A whole conversation as Markdown, for copying or downloading.
 *
 * The caller hands over each turn's text already flattened (`directivesAsText` for an
 * answer, so people blocks and lists read as text). This adds the title and who said what,
 * and drops the `[e7]` source markers: they point at chips that do not exist in a file.
 *
 * ponytail: sources are dropped, not listed. Add a footnote list per answer if exports
 * need to show where a claim came from.
 */
export type ExportTurn = { role: "user" | "assistant"; text: string };

export function chatAsMarkdown(title: string, turns: readonly ExportTurn[]): string {
  const body = turns
    .map((turn) => ({ ...turn, text: turn.text.replace(/\s*\[e\d+\]/g, "").trim() }))
    .filter((turn) => turn.text)
    .map((turn) => (turn.role === "user" ? `**You:** ${turn.text}` : `**Orbit:**\n\n${turn.text}`))
    .join("\n\n---\n\n");
  return `# ${title.trim() || "Chat"}\n\n${body}\n`;
}

/** A safe file name from the chat's title. */
export function chatExportFileName(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "chat"}.md`;
}

/** Client only: hand the browser a Markdown file to save. */
export function downloadMarkdown(fileName: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
