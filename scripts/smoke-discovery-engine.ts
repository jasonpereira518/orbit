/**
 * Smoke test for Advanced Multi-Factor People Discovery Engine
 *
 * Run: npx tsx scripts/smoke-discovery-engine.ts
 */

import "./smoke/_env";
import {
  scoreProjectAffinity,
  scoreMutualIntroPath,
  scoreEventProximity,
  scoreInstitutionalAffinity,
  generateIntroRequestDraft,
  synthesizeExplanation,
  buildDeepDiscoveryQueries,
  type RawCandidate,
  type UserDiscoveryContext,
  type ContactNetworkNode,
} from "../src/lib/discovery";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const MOCK_USER_ID = "smoke-discovery-user";

const MOCK_CONTEXT: UserDiscoveryContext = {
  userId: MOCK_USER_ID,
  projects: [
    {
      id: "proj-1",
      userId: MOCK_USER_ID,
      title: "Distributed AI Agent Orchestrator",
      summary: "Building low-latency agent pipelines using TypeScript and vector retrieval.",
      topics: ["agents", "orchestration", "inference", "typescript"],
      status: "active",
      detectedFrom: "manual",
      sourceRefs: [],
      confidence: 90,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "proj-2",
      userId: MOCK_USER_ID,
      title: "Fintech Ledger Sync",
      summary: "Double-entry bookkeeping synchronization engine.",
      topics: ["fintech", "accounting", "ledger"],
      status: "dormant",
      detectedFrom: "manual",
      sourceRefs: [],
      confidence: 70,
      lastActivityAt: new Date(Date.now() - 90 * 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
  goals: ["Lead an engineering team building developer tools"],
  careerProfile: {
    role: { title: "Senior Staff Engineer", company: "Stripe" },
    skills: ["Distributed Systems", "TypeScript", "AI Agents"],
    aim: { kind: "build", timeline: "this_term", field: "software", setAt: new Date().toISOString() },
    city: "San Francisco, CA",
  },
  schools: ["University of Michigan", "Stanford University"],
  targetCompanies: [
    { name: "Linear", priority: 1 },
    { name: "Scale AI", priority: 2 },
    { name: "Figma", priority: 3 },
  ],
  userPastCompanies: ["Stripe", "Google"],
  userEvents: [
    {
      id: "event-1",
      title: "Bay Area AI Salon",
      startsAt: new Date(Date.now() - 14 * 86_400_000),
      isUpcoming: false,
    },
    {
      id: "event-2",
      title: "San Francisco Tech Summit 2026",
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      isUpcoming: true,
    },
  ],
};

const MOCK_CONTACTS: ContactNetworkNode[] = [
  {
    contactId: "contact-alice",
    fullName: "Alice Morgan",
    company: "Scale AI",
    closenessTier: "inner",
    relationshipScore: 85,
    experiences: [
      {
        organization: "Scale AI",
        organizationNormalized: "scale ai",
        title: "VP of Product",
        startYear: 2021,
        endYear: 2024,
        isCurrent: false,
      },
      {
        organization: "Stripe",
        organizationNormalized: "stripe",
        title: "Staff Product Manager",
        startYear: 2018,
        endYear: 2021,
        isCurrent: false,
      },
    ],
    attendedEventIds: ["event-1"],
  },
  {
    contactId: "contact-bob",
    fullName: "Bob Vance",
    company: "Linear",
    closenessTier: "outer",
    relationshipScore: 40,
    experiences: [
      {
        organization: "Linear",
        organizationNormalized: "linear",
        title: "Engineer",
        startYear: 2023,
        endYear: null,
        isCurrent: true,
      },
    ],
    attendedEventIds: [],
  },
];

async function runTests() {
  console.log("\n1. Project & Experience Scorer");
  {
    const candA: RawCandidate = {
      id: "cand-1",
      fullName: "Elena Rostova",
      headline: "Staff Engineer working on multi-agent inference systems",
      company: "Scale AI",
      title: "Staff Engineer",
      topics: ["agents", "inference", "orchestration"],
      source: "web_research",
    };

    const resA = scoreProjectAffinity(candA, MOCK_CONTEXT);
    check("high project topic overlap scores well (>= 20)", resA.score >= 20, `got ${resA.score}`);
    check("identifies matched project", resA.matchedProjects.length > 0 && resA.matchedProjects[0].projectTitle.includes("AI Agent"));
    check("identifies shared topics", resA.matchedProjects[0]?.sharedTopics.includes("agents") ?? false);

    const candUnrelated: RawCandidate = {
      id: "cand-unrelated",
      fullName: "Greg Farmer",
      headline: "Agricultural Soil Specialist",
      company: "FarmCo",
      title: "Soil Analyst",
      topics: ["soil", "crops"],
      source: "web_research",
    };
    const resUnrelated = scoreProjectAffinity(candUnrelated, MOCK_CONTEXT);
    check("unrelated background scores 0", resUnrelated.score === 0, `got ${resUnrelated.score}`);
  }

  console.log("\n2. Mutual Connections & Warm Intro Scorer");
  {
    // Candidate who worked at Scale AI 2022-2024 (overlaps with Alice Morgan 2021-2024)
    const candWithOverlap: RawCandidate = {
      id: "cand-overlap",
      fullName: "David Chen",
      company: "Scale AI",
      title: "Tech Lead",
      experienceHistory: [
        {
          organization: "Scale AI",
          startYear: 2022,
          endYear: 2024,
          isCurrent: false,
        },
      ],
      source: "web_research",
    };

    const resOverlap = scoreMutualIntroPath(candWithOverlap, MOCK_CONTACTS);
    check("overlapping workplace tenure scores high (>= 20)", resOverlap.score >= 20, `got ${resOverlap.score}`);
    check("selects Alice Morgan as introducer", resOverlap.bestIntroPath?.introducerName === "Alice Morgan");
    check("notes colleague relationship in context", resOverlap.bestIntroPath?.relationshipContext.includes("Scale AI") ?? false);
    check("intro feasibility is high for inner tier", resOverlap.bestIntroPath?.introFeasibility === "high");

    // Candidate with outer-tier contact
    const candOuter: RawCandidate = {
      id: "cand-outer",
      fullName: "Sam Linear",
      company: "Linear",
      title: "Frontend Dev",
      source: "web_research",
    };
    const resOuter = scoreMutualIntroPath(candOuter, MOCK_CONTACTS);
    check("outer tier introducer yields lower score (< 15)", resOuter.score < 15, `got ${resOuter.score}`);
    check("intro feasibility is medium for outer tier", resOuter.bestIntroPath?.introFeasibility === "medium");
  }

  console.log("\n3. Event & Community Proximity Scorer");
  {
    const candEvent: RawCandidate = {
      id: "cand-event",
      fullName: "Maya Lin",
      company: "Anthropic",
      title: "Researcher",
      source: "event_attendee",
      signals: ["speaker"],
      sharedEvents: [
        {
          eventId: "event-1",
          eventTitle: "Bay Area AI Salon",
          startsAt: new Date(Date.now() - 14 * 86_400_000),
          isUpcoming: false,
        },
        {
          eventId: "event-2",
          eventTitle: "San Francisco Tech Summit 2026",
          startsAt: new Date(Date.now() + 7 * 86_400_000),
          isUpcoming: true,
        },
      ],
    };

    const resEvent = scoreEventProximity(candEvent, MOCK_CONTEXT);
    check("past + upcoming event + speaker bonus reaches near max (>= 18)", resEvent.score >= 18, `got ${resEvent.score}`);
    check("records coAttendedCount", resEvent.eventOverlap?.coAttendedCount === 1);
    check("records upcomingSharedEvent", resEvent.eventOverlap?.upcomingSharedEvent === "San Francisco Tech Summit 2026");
  }

  console.log("\n4. Institutional & Target Company Scorer");
  {
    const candAlum: RawCandidate = {
      id: "cand-alum",
      fullName: "Marcus Bell",
      company: "Linear",
      title: "Senior Product Designer",
      schoolHistory: ["Stanford University"],
      source: "web_research",
    };

    const resInst = scoreInstitutionalAffinity(candAlum, MOCK_CONTEXT);
    check("Stanford alum + Dream target company (Linear) hits maximum (15)", resInst.score === 15, `got ${resInst.score}`);
    check("identifies shared school", resInst.institutionalTies?.sharedSchool === "Stanford University");
    check("identifies priority 1 target company", resInst.institutionalTies?.targetCompanyPriority === 1);
  }

  console.log("\n5. Intro Draft Generator");
  {
    const draft = generateIntroRequestDraft({
      introducerFirstName: "Alice",
      candidateFullName: "Elena Rostova",
      candidateTitle: "Staff Engineer",
      candidateCompany: "Scale AI",
      relationshipContext: "Colleague at Scale AI (2022-2024)",
      projectTitle: "Distributed AI Agent Orchestrator",
      sharedTopic: "agent orchestration",
    });

    check("draft includes introducer name", draft.body.includes("Hi Alice,"));
    check("draft includes candidate name & descriptor", draft.body.includes("Elena Rostova (Staff Engineer at Scale AI)"));
    check("draft includes project reference", draft.body.includes("Distributed AI Agent Orchestrator"));
    check("draft has clean subject", draft.subject.includes("Elena Rostova"));
  }

  console.log("\n6. Query Builder");
  {
    const queries = buildDeepDiscoveryQueries(MOCK_CONTEXT);
    check("primary query incorporates project or company", queries.primaryQuery.length > 5);
    check("project queries contain active project topics", queries.projectQueries.some((q) => q.includes("Agent")));
  }

  console.log("\n7. Explainer Synthesis");
  {
    const explanation = synthesizeExplanation({
      candidate: {
        id: "cand-ex",
        fullName: "Sarah Connor",
        title: "CTO",
        company: "Cyberdyne",
        source: "network_bridge",
      },
      score: 82,
      matchedProjects: [{ projectId: "proj-1", projectTitle: "Distributed AI Agent Orchestrator", sharedTopics: ["agents"] }],
      introPath: {
        introducerContactId: "contact-alice",
        introducerName: "Alice Morgan",
        introducerTier: "inner",
        relationshipScore: 90,
        relationshipContext: "Worked together at Stripe",
        introFeasibility: "high",
      },
      reasons: ["Aligns with project", "Warm intro available via Alice Morgan"],
    });

    check("primaryWhy links project and introducer", explanation.primaryWhy.includes("Alice Morgan") && explanation.primaryWhy.includes("Distributed AI Agent"));
    check("suggestedOpener references introducer", explanation.suggestedOpener.includes("Alice Morgan"));
  }

  if (failures === 0) {
    console.log("\nAll discovery engine checks passed!");
    process.exit(0);
  } else {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
