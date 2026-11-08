import type { LeadSource, LeadStatus } from "@/db/schema";

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  open: "Open",
  intro_requested: "Intro asked",
  converted: "In contacts",
  dismissed: "Dismissed",
};

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  manual: "Added by you",
  apollo: "From Apollo",
  crm: "From your CRM",
};
