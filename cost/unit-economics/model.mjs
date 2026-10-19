#!/usr/bin/env node
// Orbit unit-economics model. No dependencies, no network, no database.
//
//   node cost/unit-economics/model.mjs                      default scenario
//   node cost/unit-economics/model.mjs --managed-ai on      count included-AI credits as Orbit's cost
//   node cost/unit-economics/model.mjs --mip 1              Deepgram at list price (no opt-out premium)
//   node cost/unit-economics/model.mjs --inputs my.json     a copy of inputs.json with your numbers
//
// Writes output/report.md and output/*.csv next to this file, and prints the report.
// Every number comes from inputs.json; nothing below is a price.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const inputs = JSON.parse(fs.readFileSync(flag("inputs", path.join(here, "inputs.json")), "utf8"));
const R = inputs.rates;
const v = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);

const SCENARIO = {
  // Included AI is coded ON but paused in production until an admin resumes it. Default off
  // (today's spend); `--managed-ai on` shows what resuming it costs.
  managedAi: flag("managed-ai", "off") === "on",
  mip: Number(flag("mip", v(R.deepgram.mipOptOutMultiplier))),
};

// Lifetime is granted by an admin, never sold, so it is not part of the model.
const PLAN_IDS = ["free", "pro", "max"];
const PROFILE_IDS = ["light", "typical", "heavy", "abusive"];
const money = (n) => (n == null || !Number.isFinite(n) ? "n/a" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: Math.abs(n) < 100 ? 2 : 0, maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 })}`);
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(0)}%` : "n/a");

/* ---------------------------------------------------------------- per-user variable cost */

const HOUR = 3600;
const GB = 1024 ** 3;

function deepgramPerMin(kind) {
  const d = R.deepgram;
  const kt = v(d.keytermPerMin) * v(d.keytermShareOfMinutes);
  if (kind === "meeting") return v(d.nova3StreamingPerMin) * SCENARIO.mip + v(d.diarizationPerMin) + kt;
  const s = v(d.shortformStreamingShare);
  return (s * v(d.nova3StreamingPerMin) + (1 - s) * v(d.nova3PrerecordedPerMin)) * SCENARIO.mip + kt;
}

function storageBytes(contacts, interactions) {
  const s = inputs.storage;
  const perEmbedding = v(s.embeddingJsonbBytes) + v(s.embeddingVectorBytes) + v(s.hnswBytesPerVector);
  const perChunk = perEmbedding + 1500; // chunk text + row overhead
  return (
    contacts * v(s.contactRowBytes) +
    contacts * v(s.embeddingsPerContact) * perEmbedding +
    contacts * v(s.memoryChunksPerContact) * perChunk +
    interactions * v(s.interactionRowBytes) +
    v(s.otherPerUserMb) * 1024 ** 2
  );
}

function userMonthlyCost(planId, profileId) {
  const plan = inputs.plans[planId];
  const p = inputs.profiles[profileId];
  const contacts = plan.contactLimit == null ? p.contacts : Math.min(p.contacts, plan.contactLimit);
  const interactions = plan.contactLimit == null ? p.interactions : Math.min(p.interactions, plan.contactLimit * 2);

  // Speech: clamped at the plan cap, plus what a modified client can stream past it (the
  // server cannot close an open socket; see COST_AUDIT.md U1). The leak lands on meetings
  // where the plan has them, and on dictation (the chat mic) on Free, which has no meetings.
  const leak = p.leakMeetingMin;
  const meetingMin = plan.meetingMin * p.meetingShare + (plan.meetingMin > 0 ? leak : 0);
  const shortMin = plan.shortformMin * p.shortformShare + (plan.meetingMin > 0 ? 0 : leak);
  const speech = meetingMin * deepgramPerMin("meeting") + shortMin * deepgramPerMin("shortform");

  const ai = SCENARIO.managedAi ? plan.credits * p.creditShare * v(R.managedAi.usdPerCredit) : 0;

  const bytes = storageBytes(contacts, interactions);
  const n = R.neon;
  const dbStorage = (bytes / GB) * (v(n.storagePerGbMonth) + v(n.historyPerGbMonth) * v(n.historyToDataRatio));

  const avatarGb = (contacts * v(inputs.storage.avatarShareOfContacts) * v(inputs.storage.avatarBytes)) / GB;
  const blob = avatarGb * v(R.vercel.blobStoragePerGbMonth) + avatarGb * 2 * v(R.vercel.blobTransferPerGb);

  const h = inputs.hosting;
  const reqs = p.dynamicRequests + v(h.backgroundRequestsPerUserMonth);
  const hosting =
    reqs *
    ((v(h.cpuSecondsPerRequest) / HOUR) * v(R.vercel.activeCpuPerHour) +
      (v(h.gbSecondsPerRequest) / HOUR) * v(R.vercel.memoryPerGbHour) +
      v(R.vercel.invocationsPerMillion) / 1e6);

  const email = p.emails * (v(R.resend.overagePerThousand) / 1000);

  return { speech, ai, dbStorage, blob, hosting, email, meetingMin, shortMin, storageMb: bytes / 1024 ** 2,
    total: speech + ai + dbStorage + blob + hosting + email };
}

/* ---------------------------------------------------------------- revenue net of fees */

function stripeFee(amount, recurring) {
  const s = R.stripe;
  const pctFee = v(s.cardPercent) + v(s.internationalSurcharge) * v(s.internationalShare) + (recurring ? v(s.billingPercent) : 0);
  return v(s.cardFixed) + amount * pctFee;
}

function netMonthlyRevenue(planId) {
  const plan = inputs.plans[planId];
  if (!plan.monthly) return 0;
  const a = v(inputs.plans.annualShare);
  const monthly = plan.monthly - stripeFee(plan.monthly, true);
  const annual = (plan.annual - stripeFee(plan.annual, true)) / 12;
  return (1 - a) * monthly + a * annual;
}

/* ---------------------------------------------------------------- fixed and tiered costs */

function tierCost(steps, units) {
  // steps: [[includedUnits, monthlyPrice], ...] ascending. Pick the first tier that covers it.
  for (const [cap, price] of steps) if (units <= cap) return price;
  return steps[steps.length - 1][1];
}

function platformCosts(users) {
  const mix = inputs.mix;
  const mau = users * mix.monthlyActiveShare;
  const lines = {};
  const notes = [];

  lines["Vercel Pro platform"] = v(R.vercel.proPlatformMonthly);

  // Hosting usage beyond the included credit is counted in per-user costs; the credit nets it.
  const cronCpu = v(inputs.hosting.fixedCronCpuHoursMonth) * v(R.vercel.activeCpuPerHour);
  lines["Vercel cron baseline"] = cronCpu;

  const cdnReq = mau * avgProfile("dynamicRequests") * v(inputs.hosting.cdnRequestsPerDynamic);
  lines["Vercel Flat Rate CDN tier"] = tierCost(v(R.vercel.cdnTierSteps), cdnReq);
  if (cdnReq > v(R.vercel.cdnIncludedRequests)) notes.push(`CDN requests ~${(cdnReq / 1e6).toFixed(1)}M/month: past the 1M included tier`);

  const n = R.neon;
  const cuRate = v(n.computePerCuHour)[v(n.plan)];
  const floorCuHours = v(n.alwaysAwake) ? v(n.minCu) * 730 : v(n.minCu) * 730 * 0.3;
  const loadCuHours = (mau / 1000) * 40; // GUESS: 40 CU-hours per 1,000 MAU above the floor
  lines["Neon compute"] = (floorCuHours + loadCuHours) * cuRate;
  if (floorCuHours + loadCuHours > 730 * 2) notes.push("Neon average above 2 CU: past the Free plan's autoscaling ceiling");

  const retained = users * v(R.clerk.retainedShareOfUsers);
  let clerk = 0;
  if (retained > v(R.clerk.freeRetainedUsers)) {
    clerk = v(R.clerk.proMonthly);
    for (const [from, to, rate] of v(R.clerk.perUserAbove)) clerk += Math.max(0, Math.min(retained, to) - from) * rate;
    notes.push(`Clerk: ~${Math.round(retained).toLocaleString()} retained users, past the 50,000 free tier`);
  }
  lines["Clerk"] = clerk;

  const emails = users * avgProfile("emails");
  const resendTiers = v(R.resend.tiers);
  let resend = tierCost(resendTiers, emails);
  const top = resendTiers[resendTiers.length - 1];
  if (emails > top[0]) resend = top[1] + ((emails - top[0]) / 1000) * v(R.resend.overagePerThousand);
  lines["Resend"] = resend;
  // The Monday Radar digest goes out over ~2 days, so a weekly email to everyone peaks near users/2 per day.
  if (users / 2 > v(R.resend.freeDaily)) notes.push(`Resend: Monday digest peak ~${Math.round(users / 2)} emails/day, past the Free plan's 100/day`);

  const errors = (mau / 1000) * v(R.sentry.errorsPer1000Mau);
  let sentry = 0;
  if (errors > v(R.sentry.developerIncludedErrors)) {
    sentry = v(R.sentry.teamMonthly) + Math.max(0, errors - v(R.sentry.teamIncludedErrors)) * v(R.sentry.overagePerError);
    notes.push(`Sentry: ~${Math.round(errors).toLocaleString()} errors/month, past the free 5k (excess is dropped, not billed, until you upgrade)`);
  }
  lines["Sentry"] = sentry;

  // Free-tier ceilings. These are outages, not bills: past them the vendor stops serving.
  const byPlan = usersByPlan(users);
  let dbBytes = 0, blobGb = 0, meetingMinutes = 0;
  for (const planId of PLAN_IDS)
    for (const prof of PROFILE_IDS) {
      const n = byPlan[planId] * inputs.mix.profileShare[prof];
      const plan = inputs.plans[planId], p = inputs.profiles[prof];
      const c = plan.contactLimit == null ? p.contacts : Math.min(p.contacts, plan.contactLimit);
      dbBytes += n * storageBytes(c, plan.contactLimit == null ? p.interactions : Math.min(p.interactions, plan.contactLimit * 2));
      blobGb += (n * c * v(inputs.storage.avatarShareOfContacts) * v(inputs.storage.avatarBytes)) / GB;
      meetingMinutes += n * userMonthlyCost(planId, prof).meetingMin;
    }
  const dbGb = dbBytes / GB;
  if (dbGb > 1) notes.push(`DB ~${dbGb.toFixed(1)} GB: past Neon Free's 1 GB/project (writes fail there; Launch bills ${money(dbGb * v(n.storagePerGbMonth))}/month)`);
  if (floorCuHours > 100) notes.push(`Neon compute ~${Math.round(floorCuHours + loadCuHours)} CU-hours: past Neon Free's 100 CU-hours/project (compute suspends there)`);
  if (blobGb > 1) notes.push(`Blob ~${blobGb.toFixed(1)} GB: past Vercel Hobby's 1 GB (Blob stops serving on Hobby)`);
  // Peak concurrent meeting streams: minutes spread over ~22 working days x 8 h, x3 for the peak hour.
  const peakStreams = (meetingMinutes / (22 * 8 * 60)) * 3;
  if (peakStreams > 150) notes.push(`~${Math.round(peakStreams)} concurrent Deepgram streams at peak: past pay-as-you-go's 150-stream limit (new meetings fail to connect)`);
  lines._dbGb = dbGb;
  lines._blobGb = blobGb;

  lines["Domains"] = (v(R.domain.comAnnual) * v(R.domain.count)) / 12;
  lines["GitHub Actions (public repo)"] = 0;

  const { _dbGb, _blobGb, ...billed } = lines;
  return { lines: billed, dbGb: _dbGb, blobGb: _blobGb, notes, total: Object.values(billed).reduce((a, b) => a + b, 0) };
}

/** Accounts per plan at a scale point, split by planShare. */
function usersByPlan(users) {
  const share = inputs.mix.planShare;
  const sum = share.free + share.pro + share.max;
  return { free: (users * share.free) / sum, pro: (users * share.pro) / sum, max: (users * share.max) / sum };
}

/** Deepgram spend per month across every account at a scale point. */
function speechSpendAt(users) {
  const byPlan = usersByPlan(users);
  let sum = 0;
  for (const planId of PLAN_IDS)
    for (const prof of PROFILE_IDS) sum += byPlan[planId] * inputs.mix.profileShare[prof] * userMonthlyCost(planId, prof).speech;
  return sum;
}

function avgProfile(field) {
  const s = inputs.mix.profileShare;
  return PROFILE_IDS.reduce((acc, id) => acc + s[id] * inputs.profiles[id][field], 0);
}

function blendedUserCost(planId) {
  const s = inputs.mix.profileShare;
  return PROFILE_IDS.reduce((acc, id) => acc + s[id] * userMonthlyCost(planId, id).total, 0);
}

/* ---------------------------------------------------------------- report */

const out = [];
const csv = {};
const line = (s = "") => out.push(s);
const table = (name, head, rows) => {
  line(`| ${head.join(" | ")} |`);
  line(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) line(`| ${r.join(" | ")} |`);
  line();
  csv[name] = [head, ...rows];
};

line(`# Orbit unit economics (model output)`);
line();
line(`Generated ${new Date().toISOString().slice(0, 10)} from \`inputs.json\`. Scenario: included AI **${SCENARIO.managedAi ? "ON (credits are Orbit's cost)" : "OFF (paused, BYOK only)"}**, Deepgram opt-out multiplier **${SCENARIO.mip}x**.`);
line(`Every GUESS in inputs.json flows into these numbers. Treat them as orders of magnitude until the README queries replace the guesses.`);
line();

line(`## 1. Cost per user per month, by plan and usage profile`);
line();
line(`Deepgram per minute in this scenario: meeting ${money(deepgramPerMin("meeting"))}, short-form ${money(deepgramPerMin("shortform"))}.`);
line();
{
  const rows = [];
  for (const planId of PLAN_IDS)
    for (const prof of PROFILE_IDS) {
      const c = userMonthlyCost(planId, prof);
      rows.push([planId, prof, Math.round(c.meetingMin + c.shortMin), c.storageMb.toFixed(0), money(c.speech), money(c.ai), money(c.dbStorage + c.blob), money(c.hosting), money(c.email), `**${money(c.total)}**`]);
    }
  table("cost_per_user", ["plan", "profile", "audio min", "DB MB", "speech", "AI (Orbit key)", "storage", "hosting", "email", "total"], rows);
}

line(`## 2. Revenue net of Stripe fees, and gross margin per paying user`);
line();
{
  const rows = [];
  for (const planId of ["pro", "max"]) {
    const net = netMonthlyRevenue(planId);
    for (const prof of PROFILE_IDS) {
      const c = userMonthlyCost(planId, prof).total;
      rows.push([planId, prof, money(inputs.plans[planId].monthly), money(net), money(c), money(net - c), pct((net - c) / net)]);
    }
  }
  table("margin_subscriptions", ["plan", "profile", "list/month", "net of fees", "cost", "margin", "margin %"], rows);
}

line(`## 3. The Deepgram credit`);
line();
{
  const usable = v(R.deepgram.oneTimeCredit) * v(R.deepgram.creditUsableShare);
  line(`A one-time ${money(v(R.deepgram.oneTimeCredit))} credit, of which the app lets itself spend ${money(usable)} before every speech surface has fallen back (src/lib/speech-cost.ts). While it lasts, speech costs no cash; the margin below shows both sides of it.`);
  line();
  const rows = [];
  for (const users of inputs.scalePoints) {
    const speech = speechSpendAt(users);
    rows.push([users.toLocaleString(), money(speech), speech > 0 ? `${(usable / speech).toFixed(1)} mo` : "never runs out"]);
  }
  table("deepgram_credit", ["users", "Deepgram / month", "credit lasts"], rows);
}

line(`## 4. Free users`);
line();
{
  const free = PROFILE_IDS.map((p) => [p, money(userMonthlyCost("free", p).total)]);
  table("free_cost", ["profile", "cost/month"], free);
  const maxed = userMonthlyCost("free", "heavy").total + (SCENARIO.managedAi ? v(inputs.plans.freeStarterCredits) * 0.01 / 12 : 0);
  const proMargin = netMonthlyRevenue("pro") - blendedUserCost("pro");
  const freeBlend = blendedUserCost("free");
  line(`A Free user who uses every metered feature to its cap costs **${money(maxed)}/month**; the blended Free user costs ${money(freeBlend)}.`);
  line(`A blended Pro subscriber contributes ${money(proMargin)}/month. Conversion needed for Pro to carry Free:`);
  line(`- maxed Free users: **${pct(maxed / (maxed + proMargin))}** of signups must pay`);
  line(`- blended Free users: **${pct(freeBlend / (freeBlend + proMargin))}** of signups must pay (before fixed costs)`);
  line();
}

line(`## 5. Scale points`);
line();
{
  const rows = [];
  const notesAt = [];
  const mix = inputs.mix.planShare;
  for (const users of inputs.scalePoints) {
    const plat = platformCosts(users);
    void mix;
    let variable = 0;
    let revenue = 0;
    for (const planId of PLAN_IDS) {
      const n = usersByPlan(users)[planId];
      // The usage profiles already include near-idle accounts (light), so every account is costed at its plan's blend.
      variable += n * blendedUserCost(planId);
      revenue += n * netMonthlyRevenue(planId);
    }
    const credit = Math.min(v(R.vercel.proIncludedCredit), variable * 0.15);
    const total = plat.total + variable - credit;
    rows.push([users.toLocaleString(), `${plat.dbGb.toFixed(1)} GB`, money(plat.total), money(variable), money(total), money(total / users), money(revenue), money(revenue - total), pct((revenue - total) / revenue)]);
    notesAt.push([users, plat]);
  }
  table("scale", ["users", "DB size", "platform/fixed", "variable", "total cost", "cost/user", "net revenue (subs)", "monthly margin", "margin %"], rows);
  line(`Speech is counted as a cost here even though the Deepgram credit pays for it at first: section 3 shows how long that lasts, and "while the credit lasts" margin is this one plus the speech column below.`);
  line();
  line(`### Variable spend by category`);
  line();
  const cat = [];
  for (const users of inputs.scalePoints) {
    const sums = { speech: 0, meetingSpeech: 0, ai: 0, dbStorage: 0, blob: 0, hosting: 0, email: 0 };
    const byPlan = usersByPlan(users);
    for (const planId of PLAN_IDS)
      for (const prof of PROFILE_IDS) {
        const n = byPlan[planId] * inputs.mix.profileShare[prof];
        const c = userMonthlyCost(planId, prof);
        for (const k of ["speech", "ai", "dbStorage", "blob", "hosting", "email"]) sums[k] += n * c[k];
        sums.meetingSpeech += n * c.meetingMin * deepgramPerMin("meeting");
      }
    cat.push([users.toLocaleString(), money(sums.speech), money(sums.meetingSpeech), money(sums.ai), money(sums.dbStorage), money(sums.blob), money(sums.hosting), money(sums.email)]);
  }
  table("spend_by_category", ["users", "speech (all)", "of which meetings", "AI (Orbit key)", "DB storage", "Blob", "functions", "email"], cat);
  line(`### Pricing cliffs by scale point`);
  line();
  for (const [users, plat] of notesAt) {
    line(`- **${users.toLocaleString()} users**: ${plat.notes.length ? plat.notes.join("; ") : "no vendor tier change"}. Platform lines: ${Object.entries(plat.lines).filter(([, x]) => x > 0).map(([k, x]) => `${k} ${money(x)}`).join(", ")}`);
  }
  line();
}

line(`## 6. Break-even`);
line();
{
  const plat = platformCosts(1000).total;
  const proMargin = netMonthlyRevenue("pro") - blendedUserCost("pro");
  const freeCost = blendedUserCost("free");
  const ratio = inputs.mix.planShare.free / Math.max(1e-9, inputs.mix.planShare.pro + inputs.mix.planShare.max);
  const perPaid = proMargin - ratio * freeCost;
  line(`Fixed platform cost at ~1,000 users: ${money(plat)}/month. Blended Pro contribution ${money(proMargin)}; with ${ratio.toFixed(1)} Free users per subscriber, each subscriber nets ${money(perPaid)}.`);
  line(perPaid > 0 ? `**Break-even: ~${Math.ceil(plat / perPaid)} paying subscribers** at this plan mix, counting speech at full price (fewer while the Deepgram credit pays for it).` : `**No break-even at this mix: each subscriber does not cover the Free users behind them.**`);
  line();
}

line(`## 7. Sensitivity (monthly margin at 1,000 and 10,000 users)`);
line();
{
  const base = JSON.parse(JSON.stringify(inputs));
  const marginAt = (mutate, users) => {
    const saved = JSON.stringify(inputs);
    mutate(inputs);
    const plat = platformCosts(users).total;
    let variable = 0, revenue = 0;
    for (const planId of PLAN_IDS) {
      const n = usersByPlan(users)[planId];
      variable += n * blendedUserCost(planId);
      revenue += n * netMonthlyRevenue(planId);
    }
    const r = revenue - plat - variable;
    Object.assign(inputs, JSON.parse(saved));
    return r;
  };
  const b1 = marginAt(() => {}, 1000);
  const b = marginAt(() => {}, 10000);
  const rows = [["baseline", money(b1), "-", money(b), "-"]];
  const add = (label, fn) => {
    const m1 = marginAt(fn, 1000);
    const m = marginAt(fn, 10000);
    rows.push([label, money(m1), money(m1 - b1), money(m), money(m - b)]);
  };
  add("Pro $6.99", (i) => (i.plans.pro.monthly = 6.99, i.plans.pro.annual = 69.99));
  add("Pro $11.99", (i) => (i.plans.pro.monthly = 11.99, i.plans.pro.annual = 119.99));
  add("Max $24.99", (i) => (i.plans.max.monthly = 24.99, i.plans.max.annual = 249.99));
  add("Free limit 250 contacts", (i) => (i.plans.free.contactLimit = 250));
  add("Free limit 1,000 contacts", (i) => (i.plans.free.contactLimit = 1000));
  add("Free short-form 60 → 15 min", (i) => (i.plans.free.shortformMin = 15));
  add("Pro speech 5h+5h → 3h+3h", (i) => (i.plans.pro.meetingMin = 180, i.plans.pro.shortformMin = 180));
  add("Deepgram at list (no opt-out premium)", () => (SCENARIO.mip = 1));
  SCENARIO.mip = Number(flag("mip", v(R.deepgram.mipOptOutMultiplier)));
  const savedAi = SCENARIO.managedAi;
  SCENARIO.managedAi = true;
  add("Included AI resumed (current allowances)", () => {});
  add("Included AI resumed, Free 50 → 10 credits", (i) => (i.plans.free.credits = 10));
  add("Included AI resumed, Free 0, Pro 300 → 150", (i) => (i.plans.free.credits = 0, i.plans.pro.credits = 150));
  SCENARIO.managedAi = savedAi;
  add("Conversion +1 pt (free 88% → 87%, pro +1)", (i) => (i.mix.planShare.free -= 0.01, i.mix.planShare.pro += 0.01));
  add("Heavy share 13% → 25%", (i) => (i.mix.profileShare.light -= 0.12, i.mix.profileShare.heavy += 0.12));
  add("Embeddings: drop the duplicate jsonb copy", (i) => (i.storage.embeddingJsonbBytes.value = 0));
  table("sensitivity", ["change", "1k margin/mo", "1k vs base", "10k margin/mo", "10k vs base"], rows);
  void base;
}

line(`## Assumptions that are guesses`);
line();
const guesses = [];
const walk = (o, p = "") => {
  for (const [k, x] of Object.entries(o)) {
    if (x && typeof x === "object" && x.status === "GUESS") guesses.push(`\`${p}${k}\` = ${JSON.stringify(x.value)} (${x.unit})`);
    else if (x && typeof x === "object" && !Array.isArray(x)) walk(x, `${p}${k}.`);
  }
};
walk(inputs);
for (const g of guesses) line(`- ${g}`);
line(`- usage profiles and the plan mix (\`profiles\`, \`mix\`): all guesses`);
line(`- Neon load: 40 CU-hours per 1,000 MAU above the floor (in model.mjs)`);
line();

// A scenario run writes beside the default rather than over it: `report.md` is always the
// default scenario, `report.mip-1.md` the list-price one, and so on.
const suffix = [
  SCENARIO.managedAi ? "managed-ai-on" : null,
  flag("mip", null) !== null ? `mip-${SCENARIO.mip}` : null,
  flag("inputs", null) !== null ? path.basename(flag("inputs"), ".json") : null,
].filter(Boolean).join(".");
const named = (base, ext) => `${base}${suffix ? `.${suffix}` : ""}.${ext}`;
const outDir = path.join(here, "output");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, named("report", "md")), out.join("\n"));
for (const [name, rows] of Object.entries(csv)) {
  const strip = (c) => String(c).replace(/\*\*/g, "");
  fs.writeFileSync(path.join(outDir, named(name, "csv")), rows.map((r) => r.map((c) => `"${strip(c).replace(/"/g, '""')}"`).join(",")).join("\n") + "\n");
}
console.log(out.join("\n"));
