/**
 * The recruiter scan's `import_type`, alone in its own module.
 *
 * `import-job-dispatch.ts` reads this at module scope (RESUMABLE_IMPORT_TYPES), and it sits
 * in a cycle with the processor: gmail-scan-processor → import-job-processor →
 * import-engine → the adapters → import-job-dispatch → gmail-scan-processor. Whichever
 * module an entry point loads first decided whether the constant was initialised yet, so
 * importing the processor directly threw "Cannot access 'GMAIL_SCAN_IMPORT_TYPE' before
 * initialization". A module with no imports of its own is always ready.
 */
export const GMAIL_SCAN_IMPORT_TYPE = "gmail_recruiter_scan";
