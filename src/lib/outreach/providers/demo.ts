import { createHash } from "node:crypto";
import type { EnrichmentProvider, SearchProvider } from "@/lib/outreach/providers/types";

/**
 * Explicit demo mode (spec §7.5): selected only for demo accounts with no usable key, or by a
 * smoke test. Every profile URL contains `/in/demo-` and every email uses the reserved
 * example.com domain, so demo data can never be mistaken for, or delivered to, a real person.
 */
export const DEMO_EMAIL_DOMAIN = "example.com";

const FIRST = ["Avery", "Jordan", "Priya", "Mateo", "Hana", "Olu", "Sofia", "Kenji", "Lena", "Marcus", "Noor", "Tomas"];
const LAST = ["Chen", "Okafor", "Silva", "Novak", "Haddad", "Iyer", "Brooks", "Larsen", "Moreau", "Park", "Reyes", "Stone"];
const COMPANIES = ["Northwind", "Contoso", "Fabrikam", "Tailspin", "Wingtip", "Litware"];
const PLACES = ["New York", "San Francisco", "Austin", "London", "Toronto"];

function seedOf(text: string) {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

export function createDemoSearch(): SearchProvider {
  return {
    name: "demo",
    async search(q, { count, offset }) {
      const role = q.match(/"([^"]+)"/)?.[1] ?? "Partnerships Lead";
      const seed = seedOf(`${q}:${offset}`);
      const size = Math.min(count, 8);
      const results = Array.from({ length: size }, (_, i) => {
        const n = (seed + i * 7) >>> 0;
        const name = `${FIRST[n % FIRST.length]} ${LAST[(n >>> 4) % LAST.length]}`;
        const company = COMPANIES[(n >>> 8) % COMPANIES.length];
        const place = PLACES[(n >>> 12) % PLACES.length];
        const slug = `demo-${name.toLowerCase().replace(/\s+/g, "-")}-${n % 997}`;
        return {
          url: `https://www.linkedin.com/in/${slug}`,
          title: `${name} - ${role} - ${company} | LinkedIn`,
          description: `${role} at ${company} · Experience: ${company} · Location: ${place} · Demo profile`,
          extraSnippets: [],
        };
      });
      return { results, moreAvailable: offset < 1 };
    },
  };
}

export function createDemoEnrichment(): EnrichmentProvider {
  return {
    name: "demo",
    async match(input) {
      if (!input.linkedinUrl && !input.fullName) return null;
      const name = input.fullName ?? "Demo Person";
      const local = name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
      return {
        apolloId: `demo-${seedOf(input.linkedinUrl ?? name)}`,
        fullName: name,
        title: null,
        company: input.organization ?? null,
        organizationDomain: null,
        location: null,
        linkedinUrl: input.linkedinUrl ?? null,
        email: `${local}@${DEMO_EMAIL_DOMAIN}`,
        emailStatus: "unverified",
        employment: [],
      };
    },
  };
}
