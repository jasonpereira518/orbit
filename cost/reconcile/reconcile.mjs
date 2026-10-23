#!/usr/bin/env node
// Monthly reconciliation: do the admin cost screens match the vendors' invoices?
//
//   node cost/reconcile/reconcile.mjs cost/reconcile/example/invoices.json cost/reconcile/example/admin-export.json
//
// invoices.json   typed from each vendor's invoice or billing page (see README.md for where).
// admin-export.json   the output of the read-only queries in README.md, run by you against
//                 the database. This script never connects to anything.
//
// Exit code 1 when any check fails, so it can gate a monthly checklist or a CI job that you
// feed with a private file.

import fs from "node:fs";

const [invoicesPath, exportPath] = process.argv.slice(2);
if (!invoicesPath || !exportPath) {
  console.error("usage: reconcile.mjs <invoices.json> <admin-export.json>");
  process.exit(2);
}
const invoices = JSON.parse(fs.readFileSync(invoicesPath, "utf8"));
const admin = JSON.parse(fs.readFileSync(exportPath, "utf8"));

// Tolerances. A bill restated by cents is noise; a missing provider is not.
const ABS_CENTS = 100;
const REL = 0.05;
const USAGE_REL = 0.1;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const within = (a, b, rel, abs = 0) => Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);

if (invoices.month !== admin.month) {
  console.error(`month mismatch: invoices ${invoices.month}, export ${admin.month}`);
  process.exit(2);
}

// 1. Every invoiced provider is entered in infra_costs, at the invoiced amount.
const entered = new Map((admin.infraCosts ?? []).map((r) => [String(r.provider).toLowerCase(), Number(r.amount_cents)]));
for (const inv of invoices.bills) {
  const key = inv.provider.toLowerCase();
  const got = entered.get(key);
  if (got == null && inv.amountCents === 0) check(`infra_costs ${key}`, true, "free tier this month, nothing to enter");
  else if (got == null) check(`infra_costs has ${key}`, false, `invoice ${usd(inv.amountCents)}, not entered (Money screen undercounts)`);
  else check(`infra_costs ${key} matches invoice`, within(got, inv.amountCents, REL, ABS_CENTS), `entered ${usd(got)} vs invoice ${usd(inv.amountCents)}`);
  entered.delete(key);
}
for (const [provider, cents] of entered) check(`infra_costs ${provider} has an invoice`, false, `entered ${usd(cents)} with no invoice in invoices.json`);

// 2. Deepgram: minutes billed vs minutes metered. Orbit meters what browsers report, so a gap
//    above tolerance means unmetered streaming (tampered client, lost beacon, retries).
if (invoices.deepgram) {
  const meteredMin = (Number(admin.speechSeconds?.meeting ?? 0) + Number(admin.speechSeconds?.shortform ?? 0)) / 60;
  const billedMin = Number(invoices.deepgram.minutes);
  check("Deepgram minutes billed ≈ speech_usage", within(billedMin, meteredMin, USAGE_REL, 10), `billed ${billedMin.toFixed(0)} min vs metered ${meteredMin.toFixed(0)} min (${meteredMin ? ((billedMin / meteredMin - 1) * 100).toFixed(1) : "n/a"}% over)`);
  const perMin = Number(invoices.deepgram.amountCents) / 100 / Math.max(1, billedMin);
  check("Deepgram effective rate recorded", true, `$${perMin.toFixed(4)}/min effective: put this in inputs.json rates.deepgram (it settles the opt-out multiplier question)`);
}

// 3. Included AI: provider invoices vs Orbit-paid usage_events. The ledger prices tokens at list,
//    so the provider bill should be close; web-search fees are known to be missing from it.
for (const ai of invoices.ai ?? []) {
  const ledger = Number(admin.orbitAiMicros?.[ai.provider] ?? 0) / 10_000; // micros -> cents
  check(`${ai.provider} invoice ≈ usage_events (key_owner='orbit')`, within(ledger, ai.amountCents, 0.15, ABS_CENTS), `ledger ${usd(ledger)} vs invoice ${usd(ai.amountCents)}`);
}

// 4. Stripe: the Money screen estimates fees as 2.9% + 30c x ONE charge. Compare with the real fee total.
if (invoices.stripe) {
  const gross = Number(admin.stripe?.grossCents ?? 0);
  const charges = Number(admin.stripe?.chargeCount ?? 0);
  const screen = Math.round(gross * 0.029 + 30); // what admin/billing/costs shows today
  const better = Math.round(gross * 0.029 + charges * 30 + Number(admin.stripe?.recurringCents ?? 0) * 0.007);
  check("Stripe fees: Money screen estimate", within(screen, invoices.stripe.feesCents, REL, ABS_CENTS), `screen ${usd(screen)} vs actual ${usd(invoices.stripe.feesCents)}`);
  check("Stripe fees: per-charge + Billing estimate", within(better, invoices.stripe.feesCents, 0.1, ABS_CENTS), `estimate ${usd(better)} vs actual ${usd(invoices.stripe.feesCents)}`);
}

// 5. Cost per active user, for the weekly number.
const totalCents = invoices.bills.reduce((a, b) => a + b.amountCents, 0) + (invoices.stripe?.feesCents ?? 0);
if (admin.monthlyActiveUsers) {
  check("cost per monthly active user", true, `${usd(totalCents / admin.monthlyActiveUsers)} (${usd(totalCents)} / ${admin.monthlyActiveUsers} MAU)`);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed for ${invoices.month}.`);
process.exit(failed ? 1 : 0);
