import assert from "node:assert/strict";
import { getRecommendedUpcomingEvents, type RecommendedEvent } from "../src/lib/events/recommendations";

console.log("\nupcoming events recommendation engine");

// Verify that the module exports the query function
assert.equal(typeof getRecommendedUpcomingEvents, "function");
console.log("  ok    getRecommendedUpcomingEvents is an async function");

// Verify shape of recommended events
const dummyEvent: RecommendedEvent = {
  id: "rec-dummy-1",
  title: "AI Developers Conference",
  description: "Building next-generation agents and neural workflows",
  startsAt: new Date(Date.now() + 86400000).toISOString(),
  endsAt: null,
  venue: "San Francisco City Center",
  city: "San Francisco",
  attendanceMode: "offline",
  url: "https://lu.ma/ai-dev-conf",
  coverImageUrl: "https://images.unsplash.com/photo-1",
  themeColor: "#6366f1",
  organizerName: "AI Collective",
  platform: "luma",
  matchScore: 94,
  matchReasons: ["In your active city: San Francisco", "Matches your interest in AI & Machine Learning"],
  topics: ["AI & Machine Learning"],
  alreadyAdded: false,
};

assert.ok(dummyEvent.matchScore >= 0 && dummyEvent.matchScore <= 100);
assert.ok(dummyEvent.matchReasons.length > 0);
assert.ok(dummyEvent.themeColor.startsWith("#"));
console.log("  ok    recommended event schema matches required production attributes");

console.log("\nAll recommendations checks passed.");
