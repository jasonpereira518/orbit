/**
 * Context-aware search suggestions based on the user's flow, contacts, and activity.
 */

import { getDb } from "@/db";
import { contacts, userSettings } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export type OutreachSuggestion = {
  id: string;
  label: string;
  category: "role" | "company" | "trending" | "network";
  query: string;
  criteria: {
    titles?: string[];
    company?: string;
    seniorities?: string[];
    industries?: string[];
    locations?: string[];
    skills?: string[];
  };
  explanation: string;
};

const DEFAULT_SUGGESTIONS: OutreachSuggestion[] = [
  {
    id: "sug-ai-founders",
    label: "AI Infrastructure Founders in SF",
    category: "trending",
    query: "Founders building AI inference, LLM evaluation, and agentic workflows in the Bay Area",
    criteria: {
      titles: ["Co-Founder", "CEO", "Founder"],
      locations: ["San Francisco, CA"],
      skills: ["AI", "LLM", "Inference", "Agents"],
      industries: ["Artificial Intelligence", "Developer Tools"],
    },
    explanation: "High-momentum category based on current tech ecosystem activity",
  },
  {
    id: "sug-eng-leaders",
    label: "VPs of Engineering at Series A Startups",
    category: "role",
    query: "Engineering leaders scaling product and systems at high-growth Series A tech companies",
    criteria: {
      titles: ["VP of Engineering", "Head of Engineering", "Director of Engineering"],
      seniorities: ["Executive", "VP", "Director"],
      skills: ["Distributed Systems", "TypeScript", "Cloud Architecture"],
      industries: ["B2B SaaS"],
    },
    explanation: "Key decision makers evaluating new developer tools and team platforms",
  },
  {
    id: "sug-growth-leads",
    label: "Heads of Growth & Marketing in NYC",
    category: "role",
    query: "Growth leads and GTM directors driving pipeline and product-led adoption",
    criteria: {
      titles: ["Head of Growth", "VP of Growth", "Director of Demand Generation"],
      locations: ["New York, NY"],
      industries: ["Fintech", "Enterprise Software"],
    },
    explanation: "Leaders focused on outbound expansion and partnership channels",
  },
  {
    id: "sug-product-design",
    label: "Design Leads at Product-Led Companies",
    category: "trending",
    query: "Design directors and staff product designers at Linear, Figma, or similar craft-focused companies",
    criteria: {
      titles: ["Head of Design", "Design Director", "Lead Product Designer"],
      skills: ["Design Systems", "UI Polish", "Product Design"],
      industries: ["Productivity", "Developer Tools"],
    },
    explanation: "Makers who prioritize software craft, user experience, and animations",
  },
  {
    id: "sug-seed-ctos",
    label: "Technical Co-Founders & CTOs",
    category: "network",
    query: "Technical co-founders who recently raised pre-seed or seed funding",
    criteria: {
      titles: ["CTO", "Co-Founder & CTO", "Chief Technology Officer"],
      seniorities: ["Founder", "Executive"],
      skills: ["Full Stack", "System Architecture", "Python", "React"],
    },
    explanation: "Agile teams moving fast and actively adopting modern infrastructure",
  },
];

export async function getOutreachFlowSuggestions(userId: string): Promise<OutreachSuggestion[]> {
  try {
    const db = await getDb();

    // Sample top companies from the user's existing contacts
    const topCompanies = await db
      .select({
        company: contacts.company,
        count: sql<number>`count(*)::int`,
      })
      .from(contacts)
      .where(eq(contacts.userId, userId))
      .groupBy(contacts.company)
      .orderBy(sql`count(*) desc`)
      .limit(3);

    const validCompanies = topCompanies
      .map((c) => c.company?.trim())
      .filter((c): c is string => Boolean(c && c.length > 2 && c.length < 40));

    if (validCompanies.length > 0) {
      const company = validCompanies[0];
      const networkSuggestion: OutreachSuggestion = {
        id: `sug-network-${company.toLowerCase().replace(/[^a-z]/g, "")}`,
        label: `Engineering & Product Leads at ${company}`,
        category: "network",
        query: `Leaders in engineering, product, or design at ${company}`,
        criteria: {
          company,
          titles: ["VP of Engineering", "Head of Product", "Design Director"],
        },
        explanation: `Suggested from your existing network connections at ${company}`,
      };

      return [networkSuggestion, ...DEFAULT_SUGGESTIONS.slice(0, 4)];
    }
  } catch {
    // Non-blocking fallback to defaults
  }

  return DEFAULT_SUGGESTIONS;
}
