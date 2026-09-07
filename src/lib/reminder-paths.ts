import { revalidatePath } from "next/cache";

/**
 * `revalidatePath`, minus the throw when there is no request scope.
 *
 * Outside a request — a smoke script driving a server action directly — there is no
 * router cache to invalidate, so revalidation is genuinely a no-op rather than a
 * failure. Letting it throw would abort the action AFTER its writes had already
 * landed, which is the worst of both outcomes: the data changed and the caller saw
 * an exception.
 *
 * Narrow on purpose. Only the missing-store invariant is swallowed; anything else
 * is a real fault and still propagates.
 */
export function revalidatePathIfRequestScoped(path: string) {
  try {
    revalidatePath(path);
  } catch (err) {
    if (err instanceof Error && err.message.includes("static generation store")) {
      return;
    }
    throw err;
  }
}

/**
 * The routes that render reminder state. Shared rather than duplicated so the set can't
 * drift between the reminders actions and the suggested-reminders actions.
 *
 * Lives outside `src/actions/` because those modules are `"use server"`, where every
 * export must be an async function.
 */
export function revalidateReminderPaths(contactId?: string | null) {
  const paths = ["/", "/dashboard", "/reminders"];
  if (contactId) {
    paths.push(`/contacts/${contactId}`, "/graph");
  }

  for (const path of paths) {
    revalidatePathIfRequestScoped(path);
  }
}
