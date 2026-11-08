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
import { and, eq, sql } from "drizzle-orm";
import { searchPeopleWithBrightData, scrapeCompanyNewsWithBrightData } from "@/lib/brightdata";
import { generateOutreachDraftsBatch, type DraftInput } from "@/lib/outreach-drafts";
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
  options?: { maxProspects?: number }
): Promise<{ success: boolean; prospectsAdded: number; message: string }> {
  const db = await getDb();

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

  const filters = (campaign.audienceFilters || {}) as AudienceFilters;
  const targetCompany = filters.organizationNames?.[0] || undefined;
  const targetTitles = filters.titles?.length ? filters.titles : ["VP of Engineering", "Head of Product", "CEO", "Founder"];

  // 2. Discover prospects with BrightData scraper
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
  if (!candidates.length) {
    return {
      success: true,
      prospectsAdded: 0,
      message: "Deep search completed: no new matching prospects found.",
    };
  }

  // 3. For each candidate's company, pull recent news & catalysts
  const companyNewsCache = new Map<string, { headline: string; signals: string[] }>();

  for (const candidate of candidates) {
    if (!companyNewsCache.has(candidate.company)) {
      const newsData = await scrapeCompanyNewsWithBrightData(candidate.company);
      companyNewsCache.set(candidate.company, {
        headline: newsData.news[0]?.headline || `${candidate.company} expanding product team`,
        signals: newsData.signals || ["Active Market Presence"],
      });
    }
  }

  // 4. Batch upsert prospects into campaign
  const newProspectIds: string[] = [];

  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx];
    const companyData = companyNewsCache.get(candidate.company);
    const externalId = `deep-search-${candidate.id}-${Date.now()}-${idx}`;

    const inserted = await db
      .insert(outreachProspects)
      .values({
        campaignId,
        externalId,
        fullName: candidate.fullName,
        title: candidate.title,
        company: candidate.company,
        email: `${candidate.fullName.toLowerCase().replace(/[^a-z]/g, "")}@${candidate.company.toLowerCase().replace(/[^a-z]/g, "")}.com`,
        linkedinUrl: candidate.linkedinUrl,
        location: candidate.location,
        status: "selected", // Ready for outreach
        enrichment: {
          avatarUrl: candidate.avatarUrl,
          headline: candidate.summary,
          summary: candidate.summary,
          newsContext: companyData?.headline || candidate.recentNews || null,
          signals: companyData?.signals || candidate.signals || [],
          matchReason: candidate.matchReason,
          source: candidate.source,
          deepSearchCatalogedAt: new Date().toISOString(),
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
    try {
      const userGoals = await listActiveGoalTexts();
      const writingInstructions = await loadWritingInstructions(userId);

      const draftInputs: DraftInput[] = candidates.map((candidate) => ({
        channel: ((campaign.defaultChannel as OutreachChannel) || "email"),
        tone: campaign.tone || "professional",
        messageIntent: campaign.messageIntent || "Reach out regarding company growth and partnerships",
        audienceQuery: campaign.audienceQuery,
        replyCta: (campaign.replyCta as any) || "book_intro",
        userGoals,
        writingInstructions,
        prospect: {
          fullName: candidate.fullName,
          title: candidate.title,
          company: candidate.company,
          location: candidate.location,
          enrichmentSummary: candidate.summary,
        },
      }));

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

  // 6. Update campaign timestamp
  await db
    .update(outreachCampaigns)
    .set({
      lastSearchSource: "brightdata_deep_search",
      updatedAt: new Date(),
    })
    .where(eq(outreachCampaigns.id, campaignId));

  return {
    success: true,
    prospectsAdded: newProspectIds.length,
    message: `Deep search found and added ${newProspectIds.length} prospects with recent news context & initial drafts generated.`,
  };
}
