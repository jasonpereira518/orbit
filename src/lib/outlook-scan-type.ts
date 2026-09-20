/**
 * The Outlook recruiter scan's `import_type`, alone in its own module — for the same reason
 * as `gmail-scan-type.ts`: `import-job-dispatch.ts` reads it at module scope, and the
 * processor sits in an import cycle with it, so importing the constant from the processor
 * can hit it before initialisation. A module with no imports of its own is always ready.
 */
export const OUTLOOK_SCAN_IMPORT_TYPE = "outlook_recruiter_scan";
