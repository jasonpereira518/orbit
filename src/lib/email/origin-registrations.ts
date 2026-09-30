/**
 * Side-effect imports that register every origin's hooks with `src/lib/email/origins.ts`.
 * Imported by every entry point that can dispatch (the drain route, `schedule.ts`, inline
 * dispatchers, smoke tests), so a send dispatched from the drain runs the same hooks as one
 * dispatched from a request.
 */
import "@/lib/email/origin-hooks/follow-up";
