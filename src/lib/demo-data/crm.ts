/**
 * The demo HubSpot: a connection that never syncs, four customers who are already in the demo
 * network (so the Work view has people), and two CRM leads — one a demo teammate knows, one
 * nobody does. Seeded through `persistCrmPage`, the same write path a real sync uses.
 */
import { hubspotRecordUrl } from "@/lib/crm/hubspot/mapping";
import type { CrmPerson } from "@/lib/crm/types";

export const DEMO_CRM_LABEL = "orbit-demo.hubspot.com";
const DEMO_PORTAL = "1000";

export type DemoCrmPerson = {
  remoteId: string;
  displayName: string;
  email: string;
  companyName: string;
  title: string;
  lifecycle: "customer" | "lead";
};

export const DEMO_CRM_PEOPLE: readonly DemoCrmPerson[] = [
  // Customers: the four demo contacts with an email, so the match is exact.
  { remoteId: "101", displayName: "Sarah Chen", email: "sarah.chen@example.com", companyName: "OpenAI", title: "Partnerships Lead", lifecycle: "customer" },
  { remoteId: "102", displayName: "Marcus Lee", email: "marcus.lee@example.com", companyName: "Stripe", title: "Technical Recruiter", lifecycle: "customer" },
  { remoteId: "103", displayName: "James Okafor", email: "james@bellwether.example", companyName: "Bellwether Ventures", title: "Partner", lifecycle: "customer" },
  { remoteId: "104", displayName: "Maya Thompson", email: "maya.thompson@example.com", companyName: "Innovate Carolina", title: "Program Director", lifecycle: "customer" },
  // Leads: Alex knows Leo (outer), so this one arrives with a path; nobody knows Nora.
  { remoteId: "201", displayName: "Leo Martins", email: "leo@northwind.example", companyName: "Northwind Health", title: "Procurement Lead", lifecycle: "lead" },
  { remoteId: "202", displayName: "Nora Quinn", email: "nora@harborline.example", companyName: "Harborline", title: "COO", lifecycle: "lead" },
];

export function demoCrmPeople(): CrmPerson[] {
  return DEMO_CRM_PEOPLE.map((p) => ({
    remoteType: "contact",
    remoteId: p.remoteId,
    lifecycle: p.lifecycle,
    stage: p.lifecycle,
    displayName: p.displayName,
    email: p.email,
    phone: null,
    linkedinUrl: null,
    companyName: p.companyName,
    companyDomain: null,
    title: p.title,
    remoteOwnerRef: "demo-owner",
    remoteUrl: hubspotRecordUrl(DEMO_PORTAL, p.remoteId),
    lastActivityAt: null,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    properties: {},
  }));
}
