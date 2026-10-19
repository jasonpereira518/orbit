import { NotFoundFrame } from "@/components/error-fallback";

/**
 * The signed-in app's 404, inside the shell: a `notFound()` from a contact, event or meeting
 * page lands here rather than on the root fallback, which cannot name the dashboard (see
 * `app/not-found.tsx`).
 */
export default function AppNotFound() {
  return <NotFoundFrame home={{ href: "/dashboard", label: "Go to dashboard" }} />;
}
