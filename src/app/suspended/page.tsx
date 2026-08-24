import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { getDb } from "@/db";
import { eq } from "drizzle-orm";
import { userSettings } from "@/db/schema";
import { isClerkConfigured } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account suspended · Orbit" };

/**
 * The friendly surface for a suspended account.
 *
 * Deliberately at the top level rather than inside `(app)`: that group's layout calls
 * `requireUserId()`, which is exactly what throws for these users, so a page underneath it
 * could only redirect-loop. It reads the Clerk session directly for the same reason.
 *
 * It is not in PUBLIC_ROUTES, so Clerk still requires a session to see it — a signed-out
 * visitor gets the sign-in page, not this.
 */
export default async function SuspendedPage() {
  if (!isClerkConfigured()) redirect("/");

  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { suspendedAt: true },
  });

  // Not suspended (or no longer): send them back to the app rather than showing a
  // notice that does not apply.
  if (!settings?.suspendedAt) redirect("/dashboard");

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        Your account is on hold
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Orbit access for this account was suspended on{" "}
        <time dateTime={settings.suspendedAt.toISOString()} className="tabular-nums">
          {settings.suspendedAt.toISOString().slice(0, 10)}
        </time>
        . Your data has not been deleted.
      </p>
      <p className="mt-4 text-sm text-muted-foreground">
        If you think this is a mistake, reply to any email you have had from Orbit
        and we will take another look.
      </p>
      <Link
        href="/"
        className="mt-8 text-sm text-primary underline-offset-4 hover:underline"
      >
        Back to orbit
      </Link>
    </main>
  );
}
