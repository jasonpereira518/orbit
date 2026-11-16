/**
 * Whether the LinkedIn deep read (docs/superpowers/specs/2026-11-15-linkedin-deep-read-design.md)
 * is on for a user. The one gate every deep-read path asks.
 *
 * `isSurfaceReleased` alone is not enough: the relationship engine runs in background jobs, which
 * carry no browser cookie and no localhost host, so for them the coming-soon surface is always
 * closed, even for an admin. Admins are known by user id (env), which needs no request, so they
 * get deep read everywhere before launch; everyone else gets it once the surface is released.
 */
import { isAdminUser } from "@/lib/admin";
import { isSurfaceReleased } from "@/lib/surface-visibility";
import { LINKEDIN_DEEP_READ_SURFACE_KEY } from "@/lib/surfaces";

export async function deepReadOn(userId: string): Promise<boolean> {
  return isAdminUser(userId) || (await isSurfaceReleased(userId, LINKEDIN_DEEP_READ_SURFACE_KEY));
}
