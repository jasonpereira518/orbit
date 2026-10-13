import type { MetadataRoute } from "next";
import { getAppBaseUrl } from "@/lib/app-url";

/** The public marketing pages, and nothing behind a session. */
const MARKETING_PATHS = ["/", "/pricing", "/contact", "/privacy", "/terms", "/interest"];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getAppBaseUrl();
  return MARKETING_PATHS.map((path) => ({ url: `${base}${path}` }));
}
