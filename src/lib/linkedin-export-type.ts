/**
 * A kept LinkedIn export's `import_type`, alone in an import-free module for the same reason as
 * `drive-import-type.ts`: the job dispatch reads it at module scope, and
 * `scripts/smoke-import-sources.ts` reads it out of source text.
 */
export const LINKEDIN_EXPORT_IMPORT_TYPE = "linkedin_export";
