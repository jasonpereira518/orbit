import type { MetadataRoute } from "next";
import { getAppBaseUrl } from "@/lib/app-url";

/**
 * Marketing pages are open; the signed-in app, the admin console and every API route are
 * not. They are behind a session anyway, so this only keeps crawlers from burning requests
 * on sign-in redirects. `/robots.txt` and `/sitemap.xml` skip the proxy altogether (its matcher
 * excludes `.txt` and `.xml`) and stay in `PUBLIC_ROUTES` as a net should that regress.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/admin",
        "/dashboard",
        "/contacts",
        "/capture",
        "/chat",
        "/events",
        "/graph",
        "/imports",
        "/knowledge",
        "/meetings",
        "/outreach",
        "/radar",
        "/recruiters",
        "/reminders",
        "/settings",
        "/onboarding",
        "/upgrade",
        "/sign-in",
        "/sign-up",
        "/scan/",
      ],
    },
    sitemap: `${getAppBaseUrl()}/sitemap.xml`,
  };
}
