"use server";

import { revalidatePath } from "next/cache";
import type { LeadStatus } from "@/db/schema";
import { searchPeople, userHasApolloKey } from "@/lib/apollo";
import { isPaywallError } from "@/lib/entitlements";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import {
  APOLLO_MAX_PAGE,
  apolloFiltersFromInput,
  coerceProspect,
  isEmptySearch,
  prospectLeadInput,
  prospectView,
  type ApolloLeadSearch,
  type ApolloProspectView,
  type ApolloSearchInput,
} from "@/lib/leads/apollo-leads";
import {
  coerceLeadInput,
  leadTargetIdentity,
  normalizeLeadInput,
  type LeadInput,
} from "@/lib/leads/lead-identity";
import { loadPipeline, type Pipeline } from "@/lib/leads/pipeline";
import { convertLeadToContact, saveLead, setLeadStatus } from "@/lib/leads/store";
import { isLeadStatus, isUuid } from "@/lib/leads/validate";
import { warmPathsForTargets } from "@/lib/leads/warm-path-query";
import { requireLeadsUser } from "@/lib/plan-guards";

/*
 * Every action starts with `requireLeadsUser()`: Server Functions answer a direct POST, so
 * this — not the nav — is the boundary, and while Leads is coming soon it refuses everyone.
 * Writes return `ActionResult` so a `UserFacingError` reaches the person instead of a digest.
 */

type SavedLead = { id: string; created: boolean };
type LeadStatusResult = { status: LeadStatus };
type ConvertedLead = { contactId: string };
type ApolloStatus = { hasApollo: boolean };

const NOT_YOURS = "That lead isn’t yours to change";

export async function loadPipelineAction(): Promise<Pipeline> {
  const userId = await requireLeadsUser();
  return loadPipeline(userId);
}

export async function saveLeadAction(input: LeadInput): Promise<ActionResult<SavedLead>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const { lead, created } = await saveLead(userId, { ...coerceLeadInput(input), source: "manual" });
    revalidatePath("/leads");
    return { id: lead.id, created };
  });
}

export async function setLeadStatusAction(
  leadId: string,
  status: LeadStatus
): Promise<ActionResult<LeadStatusResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    if (!isUuid(leadId) || !isLeadStatus(status)) throw new UserFacingError(NOT_YOURS);
    if (!(await setLeadStatus(userId, leadId, status))) throw new UserFacingError(NOT_YOURS);
    revalidatePath("/leads");
    return { status };
  });
}

export async function convertLeadAction(leadId: string): Promise<ActionResult<ConvertedLead>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    if (!isUuid(leadId)) throw new UserFacingError(NOT_YOURS);
    try {
      const { contactId } = await convertLeadToContact(userId, leadId);
      revalidatePath("/leads");
      revalidatePath("/contacts");
      return { contactId };
    } catch (err) {
      // The plan's contact cap: its message is written to be read, so it comes back as data.
      if (isPaywallError(err)) throw new UserFacingError(err.message);
      throw err;
    }
  });
}

export async function getApolloStatusAction(): Promise<ApolloStatus> {
  const userId = await requireLeadsUser();
  return { hasApollo: await userHasApolloKey(userId) };
}

export async function searchApolloLeadsAction(
  input: ApolloSearchInput,
  page: number
): Promise<ActionResult<ApolloLeadSearch>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const filters = apolloFiltersFromInput(input);
    if (isEmptySearch(filters)) {
      throw new UserFacingError("Add a title, company, place or keyword to search");
    }
    const safePage = Number.isInteger(page) && page >= 1 && page <= APOLLO_MAX_PAGE ? page : 1;
    const { prospects, total, source } = await searchPeople(userId, filters, safePage);
    const warm = await warmPathsForTargets(
      userId,
      prospects.map((p) => ({
        key: p.externalId,
        ...leadTargetIdentity(normalizeLeadInput(prospectLeadInput(p))),
      }))
    );
    return {
      rows: prospects.map((p) => ({
        prospect: prospectView(p, source),
        path: warm.status === "ok" ? (warm.paths.get(p.externalId) ?? null) : null,
      })),
      total,
      source,
      team: warm.status,
      page: safePage,
    };
  });
}

export async function saveApolloLeadAction(
  prospect: ApolloProspectView
): Promise<ActionResult<SavedLead>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const checked = coerceProspect(prospect);
    if (!checked) throw new UserFacingError("That result can’t be saved — search again");
    const { lead, created } = await saveLead(userId, {
      ...prospectLeadInput(checked),
      source: "apollo",
      apolloId: checked.externalId,
    });
    revalidatePath("/leads");
    return { id: lead.id, created };
  });
}
