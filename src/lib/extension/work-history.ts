/**
 * The work history a contact snapshot carries: a few roles and schools in
 * display order, plus the counts. Pure over a stored profile, so the snapshot
 * and a capture's response can never describe the same rows differently.
 */
import { formatExperienceDates } from "@/lib/contact-profile-format";
import type { StoredProfile } from "@/lib/contact-profile";
import type { SnapshotExperience, SnapshotWorkHistory } from "./contract";

const SNAPSHOT_ROLES = 4;
const SNAPSHOT_SCHOOLS = 2;

export function toSnapshotWorkHistory(
  profile: StoredProfile | null
): SnapshotWorkHistory | null {
  if (!profile) return null;
  // Already in display order — `getContactProfile` reads by sort_index.
  const roles = profile.experiences.filter((e) => e.kind === "role");
  const schools = profile.experiences.filter((e) => e.kind === "education");
  if (!roles.length && !schools.length) return null;

  const line = (e: StoredProfile["experiences"][number]): SnapshotExperience => ({
    organization: e.organization,
    title: e.kind === "role" ? e.title : (e.fieldOfStudy ?? e.title),
    dates: formatExperienceDates(e),
    isCurrent: e.isCurrent,
  });

  return {
    roles: roles.slice(0, SNAPSHOT_ROLES).map(line),
    roleCount: roles.length,
    schools: schools.slice(0, SNAPSHOT_SCHOOLS).map(line),
    schoolCount: schools.length,
    source: profile.source,
    capturedAt: profile.capturedAt.toISOString(),
  };
}
