"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUserId, getCurrentUserProfile } from "@/lib/auth";
import { daysAgo } from "@/lib/duplicates";

export async function getGraphData() {
  const userId = await requireUserId();
  const profile = await getCurrentUserProfile();
  const db = await getDb();

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    with: { contactTags: { with: { tag: true } } },
  });

  const nodes = [
    {
      id: "me",
      type: "user",
      data: {
        label: profile.name,
        kind: "user" as const,
      },
      position: { x: 0, y: 0 },
    },
    ...rows.map((c, i) => {
      const angle = (i / Math.max(rows.length, 1)) * Math.PI * 2;
      const radius = 180 + (6 - (c.relationshipScore || 2)) * 40;
      const dormant = daysAgo(c.lastInteractionAt) > 45;
      return {
        id: c.id,
        type: "contact",
        data: {
          label: c.fullName,
          company: c.company,
          score: c.relationshipScore,
          dormant,
          kind: "contact" as const,
          tags: c.contactTags.map((ct) => ct.tag.name),
        },
        position: {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        },
      };
    }),
  ];

  const edges = rows.map((c) => ({
    id: `me-${c.id}`,
    source: "me",
    target: c.id,
    animated: (c.relationshipScore || 0) >= 4,
    style: {
      strokeWidth: Math.max(1, (c.relationshipScore || 1) / 2),
      opacity: daysAgo(c.lastInteractionAt) > 45 ? 0.25 : 0.7,
    },
  }));

  const companies = [...new Set(rows.map((c) => c.company).filter(Boolean))] as string[];

  return { nodes, edges, companies, tags: [...new Set(rows.flatMap((c) => c.contactTags.map((ct) => ct.tag.name)))] };
}
