/**
 * Automatic Active Projects Extraction Engine.
 *
 * Scans new communications, meetings, notes, and email events that arrived or were modified
 * since the last Radar run, and uses LLM intelligence to synthesize the user's current
 * high-leverage endeavors and active projects.
 */
import { and, desc, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { completeJson } from "@/lib/ai";
import type { AiAccess } from "@/lib/ai-access";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { listActiveProjectsForUser, upsertProjectForUser, type UserProject } from "@/lib/projects/store";
import { reportError } from "@/lib/report-error";

const DAY_MS = 86_400_000;
const LOOKBACK_DEFAULT_DAYS = 14;

export type ExtractedProjectProposal = {
  title: string;
  summary: string;
  topics: string[];
  status: "active" | "dormant" | "completed";
  confidence: number;
  detectedFrom: "gmail" | "calendar" | "notes" | "manual";
};

type ActivitySnippet = {
  source: "gmail" | "calendar" | "notes";
  id: string;
  text: string;
  date: Date;
};

/**
 * Loads recent communications and notes since a given date (or fallback window).
 */
async function loadRecentActivity(userId: string, since: Date): Promise<ActivitySnippet[]> {
  const db = await getDb();
  const snippets: ActivitySnippet[] = [];

  // 1. Recent meetings and notes from interactions
  const recentInteractions = rowsOf<{
    id: string;
    interaction_type: string;
    ai_summary: string | null;
    interaction_date: Date | string;
  }>(
    await db.execute(sql`
      SELECT id, interaction_type, ai_summary, interaction_date
        FROM interactions
       WHERE user_id = ${userId}
         AND interaction_date >= ${since}
         AND ai_summary IS NOT NULL
         AND length(ai_summary) > 20
       ORDER BY interaction_date DESC
       LIMIT 25
    `)
  );

  for (const row of recentInteractions) {
    snippets.push({
      source: row.interaction_type === "meeting" ? "calendar" : "notes",
      id: row.id,
      text: `${row.interaction_type.toUpperCase()}: ${row.ai_summary}`,
      date: new Date(row.interaction_date),
    });
  }

  // 2. Recent email events from email_events
  const recentEmails = rowsOf<{
    id: string;
    kind: string;
    summary: string;
    occurred_at: Date | string;
  }>(
    await db.execute(sql`
      SELECT id, kind, summary, occurred_at
        FROM email_events
       WHERE user_id = ${userId}
         AND occurred_at >= ${since}
         AND summary IS NOT NULL
       ORDER BY occurred_at DESC
       LIMIT 25
    `)
  );

  for (const row of recentEmails) {
    snippets.push({
      source: "gmail",
      id: row.id,
      text: `EMAIL (${row.kind}): ${row.summary}`,
      date: new Date(row.occurred_at),
    });
  }

  // 3. Recent cloud notes
  const recentCloudNotes = rowsOf<{
    id: string;
    name: string;
    modified_at: Date | string | null;
  }>(
    await db.execute(sql`
      SELECT id, name, modified_at
        FROM cloud_note_files
       WHERE user_id = ${userId}
         AND (modified_at >= ${since} OR created_at >= ${since})
       ORDER BY coalesce(modified_at, created_at) DESC
       LIMIT 15
    `)
  );

  for (const row of recentCloudNotes) {
    snippets.push({
      source: "notes",
      id: row.id,
      text: `NOTE FILE: ${row.name}`,
      date: row.modified_at ? new Date(row.modified_at) : new Date(),
    });
  }

  return snippets;
}

/**
 * Prompt to extract active projects from user activity.
 */
function buildProjectExtractionPrompt(
  snippets: ActivitySnippet[],
  goals: string[],
  existingProjects: UserProject[]
) {
  const existingStr = existingProjects.length
    ? `Existing Known Projects:\n${existingProjects.map((p) => `- ${p.title}: ${p.summary ?? ""} [Topics: ${p.topics.join(", ")}]`).join("\n")}`
    : "No existing projects recorded yet.";

  const goalsStr = goals.length
    ? `Active Career/Networking Goals:\n${goals.map((g) => `- ${g}`).join("\n")}`
    : "No explicit goals.";

  const activityStr = snippets
    .slice(0, 40)
    .map((s, i) => `[${i + 1}] (${s.source.toUpperCase()} · ${s.date.toISOString().slice(0, 10)}): ${s.text}`)
    .join("\n");

  const system = `You are Orbit's context extraction engine.
Your task is to analyze the user's recent activity (emails, meeting notes, documents) alongside their career goals to identify their ACTIVE endeavors and projects.

A project is an ongoing venture, initiative, research direction, product launch, fundraising round, or significant workstream (e.g. "Series A fundraising", "Building autonomous agent harness", "Developing synthetic audio pipeline", "Designing mobile app").

Return valid JSON with an array of active projects:
{
  "projects": [
    {
      "title": "Short descriptive project name (2-6 words)",
      "summary": "1-2 sentence description of what the user is actively working on or aiming to accomplish",
      "topics": ["keyword1", "keyword2", "keyword3"],
      "status": "active" | "dormant" | "completed",
      "confidence": 60-100,
      "detectedFrom": "gmail" | "calendar" | "notes"
    }
  ]
}

Guidelines:
- Consolidate related tasks into meaningful overall projects (avoid creating a project for a single routine meeting or one-off email).
- If an existing project is still active, reuse or refine its title and update its summary/topics.
- If an existing project appears completed or abandoned, you may mark it "completed" or "dormant".
- Keep maximum 5 active projects total (focus on what actually matters right now).`;

  const user = `${goalsStr}

${existingStr}

Recent Activity (${snippets.length} items):
${activityStr}

Extract the user's currently active projects as JSON:`;

  return { system, user };
}

/**
 * Runs active project extraction for a user.
 */
export async function extractActiveProjectsForUser(
  userId: string,
  access?: AiAccess,
  options: { since?: Date; force?: boolean } = {}
): Promise<UserProject[]> {
  try {
    const since = options.since ?? new Date(Date.now() - LOOKBACK_DEFAULT_DAYS * DAY_MS);
    const [snippets, goals, existingProjects] = await Promise.all([
      loadRecentActivity(userId, since),
      listActiveGoalTextsForUser(userId),
      listActiveProjectsForUser(userId),
    ]);

    // If there is very little recent activity and we already have projects, keep existing
    if (snippets.length === 0 && existingProjects.length > 0 && !options.force) {
      return existingProjects;
    }

    // Heuristic fallback if no AI access or no activity
    if (!access || snippets.length === 0) {
      if (existingProjects.length > 0) return existingProjects;

      // Create fallback starter projects from user goals if any exist
      if (goals.length > 0) {
        for (const goal of goals.slice(0, 3)) {
          await upsertProjectForUser(userId, {
            title: goal.slice(0, 40),
            summary: goal,
            topics: goal.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 5),
            status: "active",
            detectedFrom: "manual",
            confidence: 90,
          });
        }
        return listActiveProjectsForUser(userId);
      }
      return existingProjects;
    }

    const prompt = buildProjectExtractionPrompt(snippets, goals, existingProjects);

    const raw = await completeJson(userId, {
      system: prompt.system,
      user: prompt.user,
      operation: "radar.projects.extract",
      maxOutputTokens: 1_200,
      access,
      signal: AbortSignal.timeout(12_000),
    });

    let parsed: { projects?: ExtractedProjectProposal[] } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fallback if raw JSON is wrapped
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }

    if (parsed?.projects && Array.isArray(parsed.projects)) {
      for (const proj of parsed.projects) {
        if (!proj.title) continue;
        await upsertProjectForUser(userId, {
          title: proj.title,
          summary: proj.summary,
          topics: proj.topics || [],
          status: proj.status || "active",
          detectedFrom: proj.detectedFrom || "notes",
          confidence: proj.confidence || 80,
          lastActivityAt: new Date(),
        });
      }
    }

    return await listActiveProjectsForUser(userId);
  } catch (err) {
    reportError(err, { where: "extractActiveProjectsForUser", userId });
    return await listActiveProjectsForUser(userId);
  }
}
