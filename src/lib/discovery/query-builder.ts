/**
 * Discovery Query Builder
 *
 * Synthesizes deep, high-precision search queries from the user's active projects,
 * career goals, target companies, and alma mater.
 */

import type { UserDiscoveryContext } from "./types";

export type SynthesizedDiscoveryQueries = {
  primaryQuery: string;
  projectQueries: string[];
  companyQueries: string[];
};

export function buildDeepDiscoveryQueries(
  context: UserDiscoveryContext,
  targetProjectId?: string
): SynthesizedDiscoveryQueries {
  const projectQueries: string[] = [];
  const companyQueries: string[] = [];

  const activeProjects = targetProjectId
    ? context.projects.filter((p) => p.id === targetProjectId)
    : context.projects.filter((p) => p.status === "active");

  // 1. Build queries from active projects
  for (const proj of activeProjects.slice(0, 3)) {
    const topics = (proj.topics || []).slice(0, 4).join(" ");
    if (topics) {
      projectQueries.push(`${proj.title} ${topics}`);
    } else {
      projectQueries.push(proj.title);
    }
  }

  // 2. Build queries from target companies & schools
  const targetCompanyNames = (context.targetCompanies || []).map((c) => c.name).slice(0, 3);
  const primarySchool = context.schools?.[0];

  if (targetCompanyNames.length > 0) {
    for (const comp of targetCompanyNames) {
      if (primarySchool) {
        companyQueries.push(`${primarySchool} alumni at ${comp}`);
      } else if (context.careerProfile?.role) {
        companyQueries.push(`${context.careerProfile.role} at ${comp}`);
      } else {
        companyQueries.push(`engineers and leads at ${comp}`);
      }
    }
  }

  // 3. Formulate the single best primary query
  let primaryQuery = "";
  if (projectQueries.length > 0 && targetCompanyNames.length > 0) {
    primaryQuery = `${projectQueries[0]} at ${targetCompanyNames[0]}`;
  } else if (projectQueries.length > 0) {
    primaryQuery = projectQueries[0];
  } else if (companyQueries.length > 0) {
    primaryQuery = companyQueries[0];
  } else if (primarySchool) {
    primaryQuery = `${primarySchool} alumni in tech`;
  } else {
    primaryQuery = "Software engineers and product leaders";
  }

  return {
    primaryQuery,
    projectQueries,
    companyQueries,
  };
}
