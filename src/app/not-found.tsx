// The root 404 renders outside every route group, so it has no sheet of its own and must
// carry its own styles. It used to import site.css for this, which put the whole 30 KB gz
// marketing sheet on every app route (the root not-found is every route's boundary
// fallback). This module keeps the 404 self-contained without painting any other page.
import styles from "./not-found.module.css";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.content}>
        <p className={styles.eyebrow}>404</p>
        <h1 className={styles.title}>Page not found</h1>
        <p className={styles.body}>
          That route doesn’t exist — or the link may be out of date.
        </p>
        {/* One way out, to `/`, and deliberately not "Go to dashboard": the root not-found
            is rendered into EVERY page's payload as its boundary fallback, the waitlist's
            included, so an app path named here ships in the waitlist's HTML. From `/` a
            signed-in user is one click from the app (in stealth mode, `/` IS the way in).
            See lib/waitlist-host.ts. */}
        <div className={styles.actions}>
          <Link href="/" className={styles.cta}>
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
