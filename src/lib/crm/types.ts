/**
 * What every CRM connector hands the shared write path (`src/lib/crm/persist.ts`): one person
 * as the provider describes them, already mapped. Pure and client-safe.
 */
import type { CrmLifecycle, CrmRemoteType, CrmScalar } from "@/db/schema";

export type CrmPerson = {
  remoteType: CrmRemoteType;
  remoteId: string;
  lifecycle: CrmLifecycle;
  /** The provider's raw stage, never interpreted beyond `lifecycle`. */
  stage: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  title: string | null;
  remoteOwnerRef: string | null;
  remoteUrl: string | null;
  lastActivityAt: Date | null;
  remoteCreatedAt: Date | null;
  remoteUpdatedAt: Date | null;
  properties: Record<string, CrmScalar>;
};
