import { z } from "zod";

/**
 * What the browser may send to the opportunity actions (`src/actions/opportunities.ts`).
 * `kind`, `status` and `direction` stay free strings on purpose: the actions run them through
 * `normalizeOpportunity*`, which turns an unknown value into the default rather than failing
 * the whole save, and a schema stricter than that would start refusing saves that work today.
 */

const optionalText = z.string().nullish();

export const createOpportunitySchema = z.object({
  contactId: z.string(),
  kind: z.string(),
  label: z.string(),
  direction: optionalText,
  dueDateIso: optionalText,
  status: z.string().optional(),
});

export const updateOpportunitySchema = z.object({
  id: z.string(),
  patch: z.object({
    kind: z.string().optional(),
    label: z.string().optional(),
    direction: optionalText,
    dueDateIso: optionalText,
    status: z.string().optional(),
  }),
});
