"use server";

import { requireUserId } from "@/lib/auth";
import { getNetworkStats, type NetworkStats } from "@/lib/network-stats";

export async function fetchNetworkStats(): Promise<NetworkStats> {
  const userId = await requireUserId();
  return getNetworkStats(userId);
}
