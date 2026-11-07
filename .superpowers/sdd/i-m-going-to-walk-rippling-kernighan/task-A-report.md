# Task A report
Implemented: sidebar nav `-my-1 py-1` (shadow fits in scroll box; negative margin cancels padding so layout is unchanged); ask bar scroll accepts only document/html/body or #app-main-scroll; scroll-restoration restores only after a popstate (1s-expiring module flag, consumed once), keyed on pathname + useSearchParams (template wraps in Suspense), always records /contacts offset; pure fn src/lib/scroll-restore.ts + scripts/smoke-scroll-restore.ts (pure tier); capture timestamp "EEE, MMM d, h:mm a · day label".
Tests: smoke-scroll-restore 4/4, run-smoke --check ok, tsc clean, eslint 0 errors (2 pre-existing warnings in floating-ask-bar).
Not browser-verified (no dev server allowed). Note: the separator span after the <time> remains, so the row reads "Mon, Nov 2, 8:50 AM · 4 days ago · <source>".

## Fix round 1
Effect now keyed on [pathname, scrollKeySearch(pathname, search)] (search only counts on /contacts). Popstate flag is one-shot, no expiry: consumed on next effect run. Logic moved to src/lib/scroll-restore.ts (markTraversal/consumeTraversal/scrollKeySearch); smoke extended (8 checks). Ran smoke, tsc, eslint: clean.
