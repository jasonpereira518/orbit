/**
 * Obsidian connector via the Local REST API community plugin.
 *
 * Plugin: https://github.com/coddingtonbear/obsidian-local-rest-api
 * Auth: api_key stored in connector_connections.
 * Account ref: Local REST API base URL (defaults to https://127.0.0.1:27124)
 */
import {
  loadConnectorConnection,
  markConnectorSyncResult,
} from "@/lib/connectors/connections";
import { ingestPeople, type PersonRecord } from "@/lib/ingest/people";
import { openIngestContext, finalizeIngest } from "@/lib/ingest/events";

const DEFAULT_LOCAL_REST_URL = "http://127.0.0.1:27123";

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim().replace(/^['"](.*)['"]$/, "$1");
      if (key && val) result[key.toLowerCase()] = val;
    }
  }
  return result;
}

export async function syncObsidian(connectionId: string): Promise<void> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn?.accessToken) return;

  const baseUrl = conn.accountRef || DEFAULT_LOCAL_REST_URL;
  const token = conn.accessToken;

  let fileList: { files?: string[] } = {};
  try {
    const res = await fetch(`${baseUrl}/vault/`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      await markConnectorSyncResult(connectionId, {
        ok: false,
        error: `Obsidian Local REST API returned ${res.status}`,
        retryable: true,
      });
      return;
    }
    fileList = await res.json();
  } catch {
    // Obsidian is likely closed on user's machine; reschedule quietly
    await markConnectorSyncResult(connectionId, {
      ok: true,
      cursor: conn.cursor,
      nextSyncAt: new Date(Date.now() + 60 * 60 * 1000), // Check again in 1 hour
    });
    return;
  }

  const markdownFiles = (fileList.files ?? []).filter((f) => f.endsWith(".md")).slice(0, 100);
  const people: PersonRecord[] = [];

  for (const path of markdownFiles) {
    try {
      const res = await fetch(`${baseUrl}/vault/${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      const meta = parseFrontmatter(text);

      const name = meta.name || meta.title || path.replace(/\.md$/, "").split("/").pop();
      if (!name) continue;

      if (meta.email || meta.phone || meta.company || meta.role || meta.title || meta.type === "person" || meta.tags?.includes("person")) {
        people.push({
          fullName: name,
          email: meta.email || null,
          phone: meta.phone || null,
          company: meta.company || meta.organization || null,
          title: meta.title !== name ? meta.title : (meta.role || null),
          linkedinUrl: meta.linkedin || null,
          notes: meta.notes || null,
        });
      }
    } catch {
      // Ignore single file fetch errors
    }
  }

  if (people.length > 0) {
    const ctx = await openIngestContext(conn.userId, { source: "obsidian", createsContacts: true });
    await ingestPeople(ctx, people);
    await finalizeIngest(ctx, { recalibrate: !conn.cursor?.syncedThrough });
  }

  await markConnectorSyncResult(connectionId, {
    ok: true,
    cursor: {
      ...conn.cursor,
      syncedThrough: new Date().toISOString(),
    },
  });
}
