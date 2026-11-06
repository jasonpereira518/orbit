import {
  appendLinkedInConnections,
  beginLinkedInConnections,
  matchLinkedInConnections,
  startLinkedInConnections,
} from "@/actions/linkedin-connections";
import { UserFacingError } from "@/lib/errors";
import {
  CONNECTIONS_APPEND_MAX_ROWS,
  CONNECTIONS_MATCH_MAX_ROWS,
  type ConnectionMatch,
  type StagedConnectionRow,
} from "@/lib/imports/linkedin-connections-chunks";
import {
  ENCODING_ARTIFACTS_WARNING,
  hasEncodingArtifacts,
  LinkedInExportError,
  parseLinkedInConnectionsCsv,
} from "@/lib/linkedin-connections";

/**
 * The browser half of the chunked connections import (see
 * `src/lib/imports/linkedin-connections-staging.ts`): the file is parsed here, the server is
 * asked only which rows look like people already in the network, and the chosen rows go up
 * in chunks. Neither direction carries the whole export, so its size has no ceiling.
 */

export type ConnectionPerson = StagedConnectionRow & {
  id: string;
  fullName: string;
  isRepeat: boolean;
  duplicate: ConnectionMatch["duplicate"] | null;
};

export type ConnectionsPreview = {
  columns: string[];
  totalRows: number;
  people: ConnectionPerson[];
  duplicateCount: number;
  warnings: string[];
};

const READ_FAILED = "Couldn’t read that file — is it the LinkedIn export this card asks for?";

/** `previewLinkedInCsv`'s answer, without sending the file or receiving every row back. */
export async function previewConnections(csvText: string): Promise<ConnectionsPreview | { error: string }> {
  let parsed: ReturnType<typeof parseLinkedInConnectionsCsv>;
  try {
    parsed = parseLinkedInConnectionsCsv(csvText);
  } catch (err) {
    return { error: err instanceof LinkedInExportError ? err.message : READ_FAILED };
  }
  const { columns, rows } = parsed;
  const warnings = [...parsed.warnings];
  if (hasEncodingArtifacts(rows)) warnings.push(ENCODING_ARTIFACTS_WARNING);

  const people: ConnectionPerson[] = rows.map((row, index) => ({
    id: String(index),
    index,
    ...row,
    fullName: `${row.firstName} ${row.lastName}`.trim(),
    isRepeat: false,
    duplicate: null,
  }));
  for (let start = 0; start < people.length; start += CONNECTIONS_MATCH_MAX_ROWS) {
    const chunk = people.slice(start, start + CONNECTIONS_MATCH_MAX_ROWS).map((p) => ({
      index: p.index,
      fullName: p.fullName,
      email: p.email,
      url: p.url,
      company: p.company,
      position: p.position,
    }));
    const res = await matchLinkedInConnections(chunk);
    if ("error" in res) return res;
    for (const m of res.matches) {
      const person = people[m.index];
      if (!person) continue;
      person.isRepeat = m.isRepeat;
      person.duplicate = m.duplicate;
    }
  }
  return {
    columns,
    totalRows: people.length,
    people,
    duplicateCount: people.filter((p) => p.isRepeat).length,
    warnings,
  };
}

/**
 * `startLinkedInImport` in chunks: the selected rows (all of them when `ids` is undefined)
 * are staged a chunk at a time, then the import is started. A chunk is never retried — the
 * server requires each one to start where the last ended — so any error ends the job.
 */
export async function stageAndStartConnections(
  csvText: string,
  fileName: string,
  ids?: string[],
): Promise<{ importId: string; totalRows: number }> {
  const { rows } = parseLinkedInConnectionsCsv(csvText);
  const indexes =
    ids === undefined
      ? rows.map((_, i) => i)
      : ids.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length);
  if (indexes.length === 0) throw new UserFacingError("No rows selected to import");

  const begun = await beginLinkedInConnections(fileName);
  if ("error" in begun) throw new UserFacingError(begun.error);
  for (let start = 0; start < indexes.length; start += CONNECTIONS_APPEND_MAX_ROWS) {
    const chunk: StagedConnectionRow[] = indexes.slice(start, start + CONNECTIONS_APPEND_MAX_ROWS).map((index) => {
      const row = rows[index];
      return {
        index,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        company: row.company,
        position: row.position,
        connectedOn: row.connectedOn,
        url: row.url,
      };
    });
    const res = await appendLinkedInConnections(begun.importId, start, chunk);
    if ("error" in res) throw new UserFacingError(res.error);
  }
  const started = await startLinkedInConnections(begun.importId);
  if ("error" in started) throw new UserFacingError(started.error);
  return { importId: begun.importId, totalRows: started.totalRows };
}
