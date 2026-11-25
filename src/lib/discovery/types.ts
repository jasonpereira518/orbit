/**
 * Types for the Advanced Multi-Factor People Discovery Engine
 */

import type { UserProject } from "@/db/schema";
import type { CareerProfile } from "@/db/schema";

export type CandidateSource =
  | "event_attendee"
  | "network_bridge"
  | "target_company"
  | "web_research";

export type SurfacedTier = "must_meet" | "strong_fit" | "worth_exploring";

export type DiscoveryScoreBreakdown = {
  /** 0 - 30 points: semantic & keyword alignment with active user projects & goals */
  projectRelevance: number;
  /** 0 - 25 points: mutual introducers, overlapping tenure, contact closeness */
  mutualIntroStrength: number;
  /** 0 - 20 points: co-attended past events, shared upcoming gatherings */
  eventProximity: number;
  /** 0 - 15 points: shared alma mater, former companies, target company priority */
  institutionalAffinity: number;
  /** 0 - 10 points: catalytic urgency (recent funding, new role, speaking) */
  catalystBoost: number;
};

export type IntroPath = {
  introducerContactId: string;
  introducerName: string;
  introducerTier: "inner" | "mid" | "outer";
  relationshipScore: number;
  /** e.g. "Worked together at Stripe (2021-2023)" or "Co-attended 2 AI Demo Days" */
  relationshipContext: string;
  introFeasibility: "high" | "medium";
  profileImageUrl?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
};

export type EventOverlapDetails = {
  coAttendedCount: number;
  sharedEventNames: string[];
  upcomingSharedEvent?: string | null;
};

export type InstitutionalTies = {
  sharedSchool?: string | null;
  sharedPastEmployer?: string | null;
  targetCompanyPriority?: 1 | 2 | 3 | null;
  companyName?: string | null;
};

export type MatchedProject = {
  projectId: string;
  projectTitle: string;
  sharedTopics: string[];
};

export type SurfacedCandidate = {
  id: string;
  fullName: string;
  headline?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  avatarUrl?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  source: CandidateSource;

  /** Total composite score (0 - 100) */
  score: number;
  tier: SurfacedTier;
  scoreBreakdown: DiscoveryScoreBreakdown;

  /** Warm intro details if a mutual connection is found */
  introPath?: IntroPath | null;

  /** Shared events and gatherings */
  eventOverlap?: EventOverlapDetails | null;

  /** Institutional & school ties */
  institutionalTies?: InstitutionalTies | null;

  /** Projects in common */
  matchedProjects?: MatchedProject[];

  /** Plain-language hook (e.g. "Working on AI Inference at Stripe; connected via Sarah Chen") */
  primaryWhy: string;
  /** Bullet points detailing the matching signals */
  bulletReasons: string[];
  /** Tailored conversation opener */
  suggestedOpener?: string;
};

export type RawCandidate = {
  id: string;
  fullName: string;
  headline?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  avatarUrl?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  source: CandidateSource;
  bio?: string | null;
  topics?: string[];
  experienceHistory?: Array<{
    organization: string;
    title?: string | null;
    startYear?: number | null;
    endYear?: number | null;
    isCurrent?: boolean;
  }>;
  schoolHistory?: string[];
  signals?: string[];
  newsContext?: string | null;
  sharedEvents?: Array<{
    eventId: string;
    eventTitle: string;
    startsAt: Date | null;
    isUpcoming: boolean;
  }>;
};

export type UserDiscoveryContext = {
  userId: string;
  projects: UserProject[];
  goals: string[];
  careerProfile: CareerProfile | null;
  schools: string[];
  targetCompanies: Array<{ name: string; priority: number }>;
  userPastCompanies: string[];
  userEvents: Array<{
    id: string;
    title: string;
    startsAt: Date | null;
    isUpcoming: boolean;
  }>;
};

export type DiscoveryOptions = {
  limit?: number;
  filterProjectId?: string;
  requireMutual?: boolean;
  onlyEvents?: boolean;
  fresh?: boolean;
  includeExternal?: boolean;
};
