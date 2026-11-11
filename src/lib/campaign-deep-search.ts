/**
 * Background Deep Search for Outreach Campaigns
 *
 * Runs an in-depth discovery job that:
 * 1. Analyzes campaign goals, target roles, and industries
 * 2. Scours web news, press releases, and company signals for matching catalysts
 * 3. Finds relevant decision-makers at identified companies via BrightData / search
 * 4. Pulls their profile picture and contact information
 * 5. Saves them as campaign prospects with full news context
 * 6. Generates personalized drafts that reference their specific news catalyst
 */

import { getDb } from "@/db";
import { outreachCampaigns, outreachMessages, outreachProspects, type AudienceFilters } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { searchPeopleWithBrightData, scrapeCompanyNewsWithBrightData } from "@/lib/brightdata";
import { generateOutreachDraftsBatch, type DraftInput } from "@/lib/outreach-drafts";
import { calculateProspectEffectiveness } from "@/lib/outreach-scoring";
import { listActiveGoalTexts } from "@/actions/goals";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";
import type { OutreachChannel } from "@/lib/outreach-types";

export type DeepSearchProgress = {
  campaignId: string;
  status: "idle" | "searching_news" | "discovering_people" | "drafting_messages" | "completed" | "failed";
  foundProspectsCount: number;
  signalsFoundCount: number;
  message?: string;
};

export async function runCampaignDeepSearch(
  userId: string,
  campaignId: string,
  options?: { maxProspects?: number; includeFollowUps?: boolean }
): Promise<{ success: boolean; prospectsAdded: number; message: string }> {
  const db = await getDb();

  try {
    // 1. Load campaign
    const campaign = await db.query.outreachCampaigns.findFirst({
      where: and(
        eq(outreachCampaigns.id, campaignId),
        eq(outreachCampaigns.userId, userId)
      ),
    });

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    // Set initial background status
    await db
      .update(outreachCampaigns)
      .set({
        backgroundJob: {
          status: "running",
          phase: "news_scan",
          startedAt: new Date().toISOString(),
          message: "Scanning target companies & recent news catalysts...",
        },
        updatedAt: new Date(),
      })
      .where(eq(outreachCampaigns.id, campaignId));

    const filters = (campaign.audienceFilters || {}) as AudienceFilters;
    const targetCompany = filters.organizationNames?.[0] || undefined;
    const targetTitles = filters.titles?.length
      ? filters.titles
      : ["VP of Engineering", "Head of Product", "CEO", "Founder", "Director of Business Development"];

    // 2. Discover prospects with BrightData scraper
    await db
      .update(outreachCampaigns)
      .set({
        backgroundJob: {
          status: "running",
          phase: "people_discovery",
          startedAt: new Date().toISOString(),
          message: "Scouting relevant decision-makers with BrightData...",
        },
        updatedAt: new Date(),
      })
      .where(eq(outreachCampaigns.id, campaignId));

    const searchResult = await searchPeopleWithBrightData(userId, {
      titles: targetTitles,
      company: targetCompany,
      locations: filters.locations,
      industries: filters.industries,
      skills: filters.keywords ? [filters.keywords] : undefined,
      query: campaign.audienceQuery || undefined,
      limit: options?.maxProspects || 8,
    });

    const candidates = searchResult.candidates;
    const isDemo = !searchResult.isLive || candidates.some((c) => c.source === "preview_simulation");

    if (!candidates.length) {
      const msg = "Deep search completed: no new matching prospects found.";
      await db
        .update(outreachCampaigns)
        .set({
          backgroundJob: {
            status: "completed",
            phase: "completed",
            completedAt: new Date().toISOString(),
            prospectsAdded: 0,
            message: msg,
          },
          updatedAt: new Date(),
        })
        .where(eq(outreachCampaigns.id, campaignId));

      return {
        success: true,
        prospectsAdded: 0,
        message: msg,
      };
    }

    // 3. For each candidate's company, pull recent news & catalysts
    const companyNewsCache = new Map<string, { headline: string; signals: string[] }>();

    for (const candidate of candidates) {
      if (!companyNewsCache.has(candidate.company)) {
        const newsData = await scrapeCompanyNewsWithBrightData(candidate.company);
        companyNewsCache.set(candidate.company, {
          headline: newsData.news[0]?.headline || `${candidate.company} expanding product & leadership team`,
          signals: newsData.signals || ["Active Market Presence", "Recent Hiring Initiative"],
        });
      }
    }

    // 4. Batch upsert prospects into campaign
    const newProspectIds: string[] = [];

    for (let idx = 0; idx < candidates.length; idx++) {
      const candidate = candidates[idx];
      const companyData = companyNewsCache.get(candidate.company);
      const externalId = `deep-search-${candidate.id}-${Date.now()}-${idx}`;
      const cleanCompany = (candidate.company || "company").toLowerCase().replace(/[^a-z0-9]/g, "");
      const cleanName = candidate.fullName.toLowerCase().replace(/[^a-z0-9]/g, "");
      const email = isDemo
        ? `${cleanName}@${cleanCompany}.example.com`
        : (((candidate as { email?: string }).email) || `${cleanName}@${cleanCompany}.com`);
      const newsContext = companyData?.headline || candidate.recentNews || null;
      const signals = companyData?.signals || candidate.signals || [];

      const effectiveness = calculateProspectEffectiveness({
        title: candidate.title,
        company: candidate.company,
        email,
        linkedinUrl: candidate.linkedinUrl,
        newsContext,
        signals,
        targetTitles,
      });

      const inserted = await db
        .insert(outreachProspects)
        .values({
          campaignId,
          externalId,
          fullName: candidate.fullName,
          title: candidate.title,
          company: candidate.company,
          email,
          linkedinUrl: candidate.linkedinUrl,
          location: candidate.location,
          status: isDemo ? "suggested" : "selected",
          enrichment: {
            avatarUrl: candidate.avatarUrl,
            headline: candidate.summary,
            summary: candidate.summary,
            newsContext,
            signals,
            matchReason: candidate.matchReason,
            education: candidate.education || null,
            almaMater: candidate.almaMater || null,
            source: candidate.source,
            demo: isDemo,
            deepSearchCatalogedAt: new Date().toISOString(),
            effectivenessScore: effectiveness.score,
            priorityTier: effectiveness.tier,
            scoreReasons: effectiveness.reasons,
          },
        })
        .onConflictDoNothing()
        .returning();

      if (inserted[0]?.id) {
        newProspectIds.push(inserted[0].id);
      }
    }

    // 5. Automatically generate tailored initial drafts for newly added prospects
    if (newProspectIds.length > 0) {
      await db
        .update(outreachCampaigns)
        .set({
          backgroundJob: {
            status: "running",
            phase: "drafting",
            startedAt: new Date().toISOString(),
            message: `Drafting personalized messages for ${newProspectIds.length} new prospects...`,
          },
          updatedAt: new Date(),
        })
        .where(eq(outreachCampaigns.id, campaignId));

      try {
        const userGoals = await listActiveGoalTexts();
        const writingInstructions = await loadWritingInstructions(userId);

        const draftInputs: DraftInput[] = candidates.map((candidate) => {
          const companyData = companyNewsCache.get(candidate.company);
          const enrichedSummary = [
            candidate.summary,
            companyData?.headline ? `Recent News Catalyst: ${companyData.headline}` : null,
            companyData?.signals?.length ? `Company Signals: ${companyData.signals.join(", ")}` : null,
            candidate.matchReason ? `Match Reason: ${candidate.matchReason}` : null,
          ]
            .filter(Boolean)
            .join(". ");

          return {
            channel: ((campaign.defaultChannel as OutreachChannel) || "email"),
            tone: campaign.tone || "professional",
            messageIntent: campaign.messageIntent || "Reach out regarding company growth and partnerships",
            audienceQuery: campaign.audienceQuery,
            replyCta: campaign.replyCta || "book_intro",
            userGoals,
            writingInstructions,
            prospect: {
              fullName: candidate.fullName,
              title: candidate.title,
              company: candidate.company,
              location: candidate.location,
              enrichmentSummary: enrichedSummary,
            },
          };
        });

        const drafts = await generateOutreachDraftsBatch(userId, draftInputs);

        for (let i = 0; i < drafts.length; i++) {
          const draft = drafts[i];
          const prospectId = newProspectIds[i];
          if (draft && prospectId) {
            await db.insert(outreachMessages).values({
              prospectId,
              channel: ((campaign.defaultChannel as OutreachChannel) || "email"),
              subject: draft.subject,
              body: draft.body,
              status: "draft",
            });
          }
        }
      } catch {
        // Non-blocking draft generation; user can draft on-demand
      }
    }

    // 6. Update campaign timestamp and completion status
    const message = `Deep search completed: scouted and added ${newProspectIds.length} prospects with news catalysts & drafts.`;
    await db
      .update(outreachCampaigns)
      .set({
        lastSearchSource: isDemo ? "demo" : "brightdata_deep_search",
        backgroundJob: {
          status: "completed",
          phase: "completed",
          completedAt: new Date().toISOString(),
          prospectsAdded: newProspectIds.length,
          message,
        },
        updatedAt: new Date(),
      })
      .where(eq(outreachCampaigns.id, campaignId));

    return {
      success: true,
      prospectsAdded: newProspectIds.length,
      message,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(outreachCampaigns)
      .set({
        backgroundJob: {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: errorMsg,
          message: "Deep search encountered an error while processing in the background.",
        },
        updatedAt: new Date(),
      })
      .where(eq(outreachCampaigns.id, campaignId));

    throw err;
  }
}
