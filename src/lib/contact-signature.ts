/**
 * A contact's role, company and phone from their email signature (contact-info accuracy plan,
 * PR 8). Rule-based, no model: only mail Orbit already reads (Email insights' career threads)
 * is looked at, and what it finds fills EMPTY fields as "signature", the weakest source,
 * each fill listed under "Changed by Orbit" with undo.
 *
 * Deliberately narrow. A signature is trusted only when it starts with the sender's own name
 * on a line of its own, and only the few short lines right under it are read:
 *
 *   Priya Raman
 *   Senior Recruiter | Stripe
 *   +1 (555) 010-0199
 *
 * Quoted replies (everything from "On … wrote:" or a ">" line down) are dropped first, so a
 * signature quoted from someone else's earlier message is never read as the sender's.
 */
import { companyFamilyRoot } from "@/lib/company-family";
import { normalizeCompanyKey } from "@/lib/company-name";
import { employerFromEmail } from "@/lib/email-domain-company";
import { linkedinSlug, normalizePhone } from "@/lib/duplicates";
import { nameKey } from "@/lib/names/key";

export type SignatureFields = { title?: string; company?: string; phone?: string; linkedinUrl?: string };

const QUOTE_START = /^(on .{4,200}wrote:|-{2,}\s*original message|from:\s.+@|>)/i;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;
const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i;
const NOT_A_ROLE = /@|https?:|www\.|\d{3}|^(sent from|get outlook|confidential)/i;

/** The newest message's own text, without what it quotes. */
function ownText(body: string): string[] {
  const lines = body.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const end = lines.findIndex((l) => QUOTE_START.test(l));
  return (end === -1 ? lines : lines.slice(0, end)).filter(Boolean);
}

const orgKey = (v: string) => companyFamilyRoot(v) ?? normalizeCompanyKey(v);

/** "Senior Recruiter | Stripe", "Senior Recruiter at Stripe", "Senior Recruiter, Stripe". */
function splitRole(line: string): { title: string; company?: string } {
  const parts = line.split(/\s+(?:\||·|•|–|—|-|at|@)\s+|,\s+/i).map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? { title: parts[0], company: parts.slice(1).join(" ") } : { title: line };
}

export function parseSignature(body: string, sender: { name: string; email: string }): SignatureFields {
  const lines = ownText(body);
  const want = nameKey(sender.name);
  if (!want || want.split(" ").length < 2) return {};
  // The LAST line that is just their name: the sign-off block, not a mention in the text.
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length <= 60 && nameKey(lines[i].replace(/^[-–—\s]+/, "")) === want) {
      at = i;
      break;
    }
  }
  if (at === -1) return {};
  const block = lines.slice(at + 1, at + 6);
  const out: SignatureFields = {};

  const roleLine = block.find((l) => l.length <= 80 && !NOT_A_ROLE.test(l) && !PHONE.test(l));
  if (roleLine) {
    const { title, company } = splitRole(roleLine);
    if (title.length <= 60) out.title = title;
    const next = block[block.indexOf(roleLine) + 1];
    const companyLine = company ?? (next && next.length <= 60 && !NOT_A_ROLE.test(next) && !PHONE.test(next) ? next : undefined);
    // A company only if it agrees with their work email's domain, when there is one.
    const domainCompany = employerFromEmail(sender.email);
    if (companyLine && (!domainCompany || orgKey(companyLine) === orgKey(domainCompany))) out.company = companyLine;
  }
  for (const l of block) {
    const phone = l.match(PHONE)?.[1];
    if (phone && normalizePhone(phone)) {
      out.phone = phone.trim();
      break;
    }
  }
  const li = block.join(" ").match(LINKEDIN)?.[0];
  if (li && linkedinSlug(li)) out.linkedinUrl = li.startsWith("http") ? li : `https://${li}`;
  return out;
}
