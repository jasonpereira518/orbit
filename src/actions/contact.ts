"use server";

import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { contactInboxConfig, submitContactMessageCore } from "@/lib/contact-message-submit";
import type { ContactInput, ContactResult } from "@/lib/contact-message";
import { z } from "zod";
import { defineAction, failMessage } from "@/lib/input/action";

/**
 * Whether the contact form can actually deliver. The page hides the form when this is
 * false rather than showing one that always fails.
 */
export const isContactFormEnabled = defineAction(
  { auth: "public" }, // read by the public contact page
  async (_caller) => {
    return contactInboxConfig() !== null;
  }
);

/** The request-reading half; everything else is in `lib/contact-message-submit.ts`. */
export const submitContactMessage = defineAction(
  // Public: the contact form is for people without an account. Only the shape is checked
  // here — `contactSchema` in the core does the field-by-field validation and its messages.
  { auth: "public", schema: z.tuple([z.looseObject({})]), invalid: failMessage },
  async (_caller, input: ContactInput): Promise<ContactResult> => {
    return submitContactMessageCore(input, { ip: clientIpFrom(await headers()) });
  }
);
