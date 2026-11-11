/**
 * Outbound People Discovery Agent for Radar.
 *
 * Proactively searches arXiv research papers, GitHub repositories, and developer platforms
 * for researchers, founders, and builders aligned with the user's active projects and goals.
 *
 * Dedupes against existing contacts, persists newly discovered prospects to `contacts`, and produces
 * high-priority `discovery` signals with pre-drafted context.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts } from "@/db/schema";
import type { UserProject } from "@/lib/projects/store";
import type { RadarSignal } from "@/lib/radar/types";
import { reportUnlessQuiet } from "@/lib/report-error";
import { safeHttpUrl } from "@/lib/safe-links";

const TIMEOUT_MS = 6_000;

type ArxivResult = {
  authorName: string;
  paperTitle: string;
  paperUrl: string;
  summary: string;
  published: Date;
};

type GithubResult = {
  authorName: string;
  repoName: string;
  repoUrl: string;
  summary: string;
  stars: number;
};

/**
 * Searches arXiv for recent papers matching project topics.
 */
async function searchArxiv(topic: string, limit: number = 2): Promise<ArxivResult[]> {
  try {
    const query = encodeURIComponent(`all:${topic.replace(/[^a-zA-Z0-9 ]/g, "")}`);
    const url = `https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`;
    
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "Orbit/1.0 (academic research matcher)" },
    });
    if (!res.ok) return [];

    const xml = await res.text();
    const entries: ArxivResult[] = [];
    const entryMatches = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

    for (const entry of entryMatches) {
      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
      const authorMatch = entry.match(/<author>\s*<name>([\s\S]*?)<\/name>/);
      const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
      const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);

      if (titleMatch && authorMatch && idMatch) {
        const title = titleMatch[1]!.replace(/\s+/g, " ").trim();
        const author = authorMatch[1]!.replace(/\s+/g, " ").trim();
        const summary = summaryMatch ? summaryMatch[1]!.replace(/\s+/g, " ").trim() : "";
        const paperUrl = idMatch[1]!.trim();
        const published = publishedMatch ? new Date(publishedMatch[1]!.trim()) : new Date();

        if (author && title && !title.toLowerCase().startsWith("arxiv query")) {
          entries.push({
            authorName: author,
            paperTitle: title,
            paperUrl,
            summary,
            published,
          });
        }
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Searches GitHub for recent top repositories matching project topics.
 */
async function searchGithub(topic: string, limit: number = 2): Promise<GithubResult[]> {
  try {
    const query = encodeURIComponent(topic.replace(/[^a-zA-Z0-9 ]/g, ""));
    const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=${limit}`;

    const headers: Record<string, string> = {
      "User-Agent": "Orbit-Discovery",
      Accept: "application/vnd.github.v3+json",
    };
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
    });
    if (!res.ok) return [];

    const data = await res.json();
    if (!data.items || !Array.isArray(data.items)) return [];

    const results: GithubResult[] = [];
    for (const item of data.items) {
      const owner = item.owner?.login;
      const repoName = item.name;
      const htmlUrl = item.html_url;
      const description = item.description || "";
      const stars = item.stargazers_count || 0;

      if (owner && htmlUrl) {
        results.push({
          authorName: owner,
          repoName,
          repoUrl: htmlUrl,
          summary: description,
          stars,
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Discovers new people for active projects, deduping against current contacts.
 */
export async function discoverNewPeople(
  userId: string,
  projects: readonly UserProject[],
  now: Date,
  options: { limit?: number } = {}
): Promise<Extract<RadarSignal, { kind: "discovery" }>[]> {
  if (!projects.length) return [];

  const maxTotal = options.limit ?? 3;
  const db = await getDb();

  // Load existing contact full names for simple deduplication
  const existingContacts = rowsOf<{ full_name: string }>(
    await db.execute(sql`
      SELECT lower(full_name) AS full_name
        FROM contacts
       WHERE user_id = ${userId}
       LIMIT 5000
    `)
  );
  const knownNames = new Set(existingContacts.map((c) => c.full_name.trim()));

  const signals: Extract<RadarSignal, { kind: "discovery" }>[] = [];

  // Pick top 2 most active projects
  for (const project of projects.slice(0, 2)) {
    if (signals.length >= maxTotal) break;

    const topicsToSearch = project.topics?.length ? project.topics.slice(0, 2) : [project.title];

    for (const topic of topicsToSearch) {
      if (signals.length >= maxTotal) break;

      // 1. Check arXiv for researchers
      const papers = await searchArxiv(topic, 2).catch(() => []);
      for (const p of papers) {
        if (signals.length >= maxTotal) break;
        if (knownNames.has(p.authorName.toLowerCase())) continue;

        // Create new contact record for the discovered researcher
        try {
          const [newContact] = await db
            .insert(contacts)
            .values({
              userId,
              fullName: p.authorName,
              title: `Researcher · ${p.paperTitle.slice(0, 70)}`,
              company: "Academic / Research",
              website: safeHttpUrl(p.paperUrl),
            })
            .returning();

          if (newContact) {
            knownNames.add(p.authorName.toLowerCase());
            signals.push({
              kind: "discovery",
              contactId: newContact.id,
              at: p.published,
              platform: "research",
              title: `Published: ${p.paperTitle}`,
              summary: p.summary.slice(0, 200),
              url: safeHttpUrl(p.paperUrl),
              matchingProjectTitle: project.title,
            });
          }
        } catch (err) {
          reportUnlessQuiet(err, { where: "discoverNewPeople.arxiv", userId, level: "warning" });
        }
      }

      // 2. Check GitHub for builders
      if (signals.length < maxTotal) {
        const repos = await searchGithub(topic, 2).catch(() => []);
        for (const g of repos) {
          if (signals.length >= maxTotal) break;
          if (knownNames.has(g.authorName.toLowerCase())) continue;

          try {
            const [newContact] = await db
              .insert(contacts)
              .values({
                userId,
                fullName: g.authorName,
                title: `Builder · ${g.repoName}`,
                website: safeHttpUrl(g.repoUrl),
              })
              .returning();

            if (newContact) {
              knownNames.add(g.authorName.toLowerCase());
              signals.push({
                kind: "discovery",
                contactId: newContact.id,
                at: now,
                platform: "github",
                title: `Created repo: ${g.repoName} (⭐ ${g.stars})`,
                summary: g.summary.slice(0, 200),
                url: safeHttpUrl(g.repoUrl),
                matchingProjectTitle: project.title,
              });
            }
          } catch (err) {
            reportUnlessQuiet(err, { where: "discoverNewPeople.github", userId, level: "warning" });
          }
        }
      }
    }
  }

  return signals;
}
