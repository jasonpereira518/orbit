/**
 * Which of a surface's tools this person may be offered: every one, minus those whose page has
 * not been released to them (`OrbitTool.releasedSurface`) — so a coming-soon page can never go
 * live through chat or an outside agent first. A visibility read that fails drops the gated
 * tools: closed, not open. Shared by Orbit's chat (`chatToolsFor`) and the MCP server.
 */
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { releasedTools, type OrbitTool } from "@/lib/tools/registry";

/** Whether a page is released to `userId`, as a predicate over surface keys. */
export async function releaseCheckFor(userId: string): Promise<(surfaceKey: string) => boolean> {
  try {
    const { hidden, comingSoon } = await resolveSurfaceVisibility(userId);
    return (key) => !hidden.has(key) && !comingSoon.has(key);
  } catch {
    return () => false;
  }
}

export async function releasedToolsFor(userId: string, tools: readonly OrbitTool[]): Promise<OrbitTool[]> {
  if (!tools.some((t) => t.releasedSurface)) return [...tools];
  return releasedTools(tools, await releaseCheckFor(userId));
}
