/**
 * Compatibility surface for the import engine.
 *
 * The loop that used to live here is now `runImportJob` in `@/lib/import-engine`, driven by
 * a per-import-type adapter. This module stays because its names are referenced from places
 * a rename would silently break: `startLinkedInImport`'s `after()`, the continuation route,
 * the process-stalled cron, `admin-operations.ts`, the Gmail recruiter scan runner (which
 * shares `failImport`), and both smoke guards in `scripts/` (which resolve `CHUNK_SIZE`
 * from here).
 */
export {
  CHUNK_SIZE,
  MAX_ROW_FAILURES_PER_CHUNK,
  PLAN_LIMIT_ROW_REASON,
  failImport,
} from "@/lib/import-engine";

import { runImportJob } from "@/lib/import-engine";

/**
 * The LinkedIn connections runner, unchanged in name and behavior — it is now just the
 * generic engine, which resolves the LinkedIn adapter from the job row's `import_type`.
 */
export const runLinkedInImportJob = runImportJob;
