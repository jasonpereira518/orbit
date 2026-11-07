/**
 * Which of a surface's tools this person may be offered: every one, minus those whose page has
 * not been released to them (`OrbitTool.releasedSurface`) — so a coming-soon page can never go
 * live through chat or an outside agent first. A visibility read that fails drops the gated
 * tools: closed, not open. Shared by Orbit's chat (`chatToolsFor`) and the MCP server.
 */
import { getEntitlements } from "@/lib/entitlements";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { SURFACE_FEATURE } from "@/lib/surfaces";
import { releasedTools, type OrbitTool } from "@/lib/tools/registry";

/**
 * Whether a page is released to `userId`, as a predicate over surface keys: not hidden, not
 * coming soon, not tier-locked for their plan, and their plan has the surface's feature
 * (`SURFACE_FEATURE`) — so an operator's plan rules reach chat and outside agents too.
 */
export async function releaseCheckFor(userId: string): Promise<(surfaceKey: string) => boolean> {
  try {
    const [{ hidden, comingSoon, tierLocked, exempt }, { features }] = await Promise.all([
      resolveSurfaceVisibility(userId),
      getEntitlements(userId),
    ]);
    return (key) => {
      const feature = SURFACE_FEATURE[key];
      return !hidden.has(key) && !comingSoon.has(key) && !tierLocked.has(key) && (!feature || exempt || features[feature]);
    };
  } catch {
    return () => false;
  }
}

export async function releasedToolsFor(userId: string, tools: readonly OrbitTool[]): Promise<OrbitTool[]> {
  if (!tools.some((t) => t.releasedSurface)) return [...tools];
  return releasedTools(tools, await releaseCheckFor(userId));
}
