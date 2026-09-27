"use server";

import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { contactInboxConfig, submitContactMessageCore } from "@/lib/contact-message-submit";
import type { ContactInput, ContactResult } from "@/lib/contact-message";

/**
 * Whether the contact form can actually deliver. The page hides the form when this is
 * false rather than showing one that always fails.
 */
export async function isContactFormEnabled() {
  return contactInboxConfig() !== null;
}

/** The request-reading half; everything else is in `lib/contact-message-submit.ts`. */
export async function submitContactMessage(input: ContactInput): Promise<ContactResult> {
  return submitContactMessageCore(input, { ip: clientIpFrom(await headers()) });
}
