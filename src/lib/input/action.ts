/**
 * `defineAction` — the one door every Server Action walks through (FIX_PLAN 3.1).
 *
 * Every export of a `"use server"` module is a public POST endpoint: anyone can call it with
 * any JSON-ish arguments, whatever the TypeScript signature says. Before this, 60 of 66 action
 * modules trusted their types, so a number where a title belonged was a `TypeError` 500 and a
 * garbage date an `Invalid Date` `RangeError` deep in the driver (audit M-04).
 *
 *     export const deleteThing = defineAction(
 *       { schema: z.tuple([uuid]) },
 *       async (userId, thingId: string) => { … }
 *     );
 *
 * The wrapper, in this order and before any handler code runs:
 *   1. resolves the caller — `auth: "user"` (the default) is `requireUserId()`; a function is
 *      the module's own gate (`requireAdminUserId`, `() => requireUserForReleasedSurface(K)`,
 *      …) so plan and surface checks keep running where they always ran; `{ surface }` is
 *      `requireUserForSurface`; `"public"` is an action that is deliberately unauthenticated
 *      and says so;
 *   2. parses the arguments, as one tuple, with the action's zod schema;
 *   3. calls the handler with what the gate returned, then the parsed arguments.
 *
 * A schema failure is a `UserFacingError` with a plain sentence — or, for an action whose
 * contract is to return its failures (`{ ok: false, error }`) rather than throw them, whatever
 * `invalid(message)` builds, so the caller's existing failure path shows it.
 *
 * Schemas describe what the handler already accepts; they are not where business rules live.
 * Output of the parse is what the handler receives, so a schema may normalise (a date string
 * stays a string; see `./schemas`), but most only check.
 *
 * Pure apart from the lazy auth imports, so smoke tests can drive it with a stub gate.
 */
import { z } from "zod";
import { UserFacingError } from "@/lib/errors";

/** A gate: resolves the caller or throws. Its value is the handler's first argument. */
export type ActionGate<C> = () => Promise<C>;

type ActionConfig<R> = {
  /** The arguments, as a tuple. Omit for an action that takes none (`z.tuple([])`). */
  schema?: z.ZodType;
  /**
   * The value to return when the arguments do not parse — for actions whose contract is a
   * result object rather than a throw. Without it, a `UserFacingError` is thrown.
   */
  invalid?: (message: string) => NoInfer<Awaited<R>>;
  /**
   * For an action whose old body resolved the caller inside its own `try` and returned the
   * failure as data: the same catch, now run when the gate throws. Keeps a signed-out caller
   * getting the `{ ok: false, error }` it always got instead of a thrown error.
   */
  onGateError?: (err: unknown) => Promise<NoInfer<Awaited<R>>>;
};

/** Marks the wrapper so the coverage smoke can tell a defined action from a bare function. */
export const DEFINED_ACTION = Symbol.for("orbit.definedAction");

/** A plain function type on purpose: an intersection here defeats TypeScript’s fast path for
 *  single-signature calls and turns loops like `cursor = (await action({ cursor })).next` into
 *  circular-inference errors. */
type Wrapped<A extends unknown[], R> = (...args: A) => Promise<R>;

export function defineAction<C, A extends unknown[], R>(
  config: ActionConfig<R> & { auth: ActionGate<C> },
  handler: (ctx: C, ...args: A) => Promise<R>
): Wrapped<A, R>;
export function defineAction<A extends unknown[], R>(
  config: ActionConfig<R> & { auth: "public" },
  handler: (ctx: null, ...args: A) => Promise<R>
): Wrapped<A, R>;
export function defineAction<A extends unknown[], R>(
  config: ActionConfig<R> & { auth?: "user" | { surface: string } },
  handler: (userId: string, ...args: A) => Promise<R>
): Wrapped<A, R>;
export function defineAction(
  config: ActionConfig<unknown> & {
    auth?: "user" | "public" | { surface: string } | ActionGate<unknown>;
  },
  handler: (ctx: never, ...args: never[]) => Promise<unknown>
): Wrapped<unknown[], unknown> {
  const run = handler as (ctx: unknown, ...args: unknown[]) => Promise<unknown>;
  const schema = config.schema ?? NO_ARGS;
  const gate = resolveGate(config.auth);
  const action = async (...args: unknown[]) => {
    let ctx: unknown;
    try {
      ctx = await gate();
    } catch (err) {
      if (config.onGateError) return config.onGateError(err);
      throw err;
    }
    const parsed = schema.safeParse(trimExtraArgs(schema, args));
    if (!parsed.success) {
      const message = invalidInputMessage(parsed.error);
      if (config.invalid) return config.invalid(message);
      throw new UserFacingError(message);
    }
    return run(ctx, ...(parsed.data as unknown[]));
  };
  Object.defineProperty(action, DEFINED_ACTION, { value: true });
  return action;
}

/** `true` for a function `defineAction` returned. */
export function isDefinedAction(fn: unknown): boolean {
  return typeof fn === "function" && (fn as { [DEFINED_ACTION]?: true })[DEFINED_ACTION] === true;
}

const NO_ARGS = z.tuple([]);

/**
 * Arguments past the end of a fixed tuple are dropped, not refused: a plain function ignored
 * them (a form action handed an extra `FormData`, a handler passed straight to an event), and
 * the schema exists to check what the handler reads, not to be stricter than it was.
 */
function trimExtraArgs(schema: z.ZodType, args: unknown[]): unknown[] {
  if (schema instanceof z.ZodTuple && !schema.def.rest) {
    const length = schema.def.items.length;
    return args.length > length ? args.slice(0, length) : args;
  }
  return args;
}

function resolveGate(
  auth: "user" | "public" | { surface: string } | ActionGate<unknown> | undefined
): ActionGate<unknown> {
  if (typeof auth === "function") return auth;
  if (auth === "public") return async () => null;
  if (auth && typeof auth === "object") {
    const surface = auth.surface;
    return async () => (await import("@/lib/plan-guards")).requireUserForSurface(surface);
  }
  return async () => (await import("@/lib/auth")).requireUserId();
}

/** `a.b.0.c` → "c"; `["0"]` → null. The last named key is the field a person would recognise. */
function fieldName(path: readonly PropertyKey[]): string | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const key = path[i];
    if (typeof key === "string" && key) {
      // camelCase → words: "dueDate" → "due date".
      return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
    }
  }
  return null;
}

/**
 * One plain sentence for a parse failure. Never the zod dump: the person did not write the
 * request, Orbit's own UI did, so the useful thing is which field and "try again".
 */
export function invalidInputMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue ? fieldName(issue.path) : null;
  if (issue && issue.code === "custom" && issue.message && !/^invalid/i.test(issue.message)) {
    // A shared schema's own sentence ("That due date doesn’t look right").
    return issue.message;
  }
  if (issue && issue.code === "too_big" && field) return `That ${field} is too long`;
  return field
    ? `That ${field} doesn’t look right — refresh and try again`
    : "That request didn’t look right — refresh and try again";
}

/** The `invalid` builder for actions that return `{ ok: false, error }`. */
export function failResult(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The `invalid` builder for actions that return `{ ok: false, message }`. */
export function failMessage(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/** The `invalid` builder for actions that return `{ error }`. */
export function errorResult(error: string): { error: string } {
  return { error };
}
