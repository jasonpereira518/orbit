/**
 * The Drive import's `import_type`, alone in an import-free module for the same reason as
 * `gmail-scan-type.ts`: `import-job-dispatch.ts` reads it at module scope and sits in a
 * cycle with the processors, so the constant must never be mid-initialisation.
 */
export const DRIVE_IMPORT_TYPE = "drive_docs";
