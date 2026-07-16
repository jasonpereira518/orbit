import { SignIn } from "@clerk/nextjs";
import { isClerkConfigured } from "@/lib/auth";
import Link from "next/link";

export default function SignInPage() {
  if (!isClerkConfigured()) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#fbfbf9] p-6">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
          Orbit
        </h1>
        <p className="max-w-md text-center text-muted-foreground">
          Clerk is not configured. Running in demo mode — continue to the app.
        </p>
        <Link
          href="/"
          className="rounded-lg bg-[#0f3d3e] px-4 py-2 text-sm text-white"
        >
          Open dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#fbfbf9]">
      <SignIn />
    </div>
  );
}
