import { z } from "zod";
import { lenientBoolean, lenientList, lenientString } from "@/lib/http/parse-response";

/**
 * What `lib/gmail.ts` reads from Google. Each schema lists the fields the code uses, with the
 * types it assumes; anything else the provider sends is ignored. See `parse-response.ts`.
 */

export const googleUserInfoSchema = z.object({ email: lenientString });

const peoplePersonSchema = z.object({
  resourceName: lenientString,
  names: lenientList(z.object({ displayName: lenientString, givenName: lenientString, familyName: lenientString })).optional().catch(undefined),
  organizations: lenientList(z.object({ name: lenientString, title: lenientString })).optional().catch(undefined),
  emailAddresses: lenientList(z.object({ value: lenientString })).optional().catch(undefined),
  phoneNumbers: lenientList(z.object({ value: lenientString })).optional().catch(undefined),
  photos: lenientList(z.object({ url: lenientString, default: lenientBoolean })).optional().catch(undefined),
});

export const googlePeoplePageSchema = z.object({
  connections: lenientList(peoplePersonSchema).optional(),
  nextPageToken: lenientString,
});

export const gmailMessageListSchema = z.object({
  messages: lenientList(z.object({ id: z.string(), threadId: z.string() })).optional(),
  nextPageToken: lenientString,
});

type RawGmailPayload = {
  headers?: Array<{ name: string; value: string }>;
  mimeType?: string;
  body?: { data?: string };
  parts?: RawGmailPayload[];
};

const gmailPayloadSchema: z.ZodType<RawGmailPayload> = z.lazy(() =>
  z.object({
    headers: lenientList(z.object({ name: z.string(), value: z.string() })).optional().catch(undefined),
    mimeType: lenientString,
    body: z.object({ data: lenientString }).optional().catch(undefined),
    parts: lenientList(gmailPayloadSchema).optional().catch(undefined),
  })
);

export const gmailMessageSchema = z.object({
  id: lenientString,
  threadId: lenientString,
  snippet: lenientString,
  internalDate: lenientString,
  payload: gmailPayloadSchema.optional().catch(undefined),
});

export const gmailThreadSchema = z.object({
  id: lenientString,
  messages: lenientList(gmailMessageSchema).optional(),
});
