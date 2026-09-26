import type { Instrumentation } from "next";

/**
 * Runs once per server instance, before it serves requests.
 *
 * Two jobs: say at boot what production is missing (`src/lib/env.ts`; the build already
 * refused to deploy on errors, this is the belt to those braces), and load Sentry for
 * the runtime we are on. Everything is a dynamic import so the edge bundle stays small
 * and nothing here reaches `@/db`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnvReport } = await import("@/lib/env");
    const report = getEnvReport();
    for (const e of report.errors) console.error(`[env] ${e}`);
    if (report.warnings.length > 0 && process.env.VERCEL_ENV === "production") {
      console.warn(`[env] ${report.warnings.length} optional variable(s) unset: ${report.warnings.map((w) => w.split(" ")[0]).join(", ")}`);
    }
    // Without a DSN the init is inert (`enabled: false`), but loading the server SDK still
    // costs every cold instance ~80ms before its first request. Skip the load too.
    if (process.env.SENTRY_DSN) await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

/** Every uncaught server error, whatever rendered it. See `src/lib/request-errors.ts`. */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { reportRequestError } = await import("@/lib/request-errors");
  await reportRequestError(err, request, context);
};
