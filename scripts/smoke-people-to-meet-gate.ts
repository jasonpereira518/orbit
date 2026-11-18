/** People to meet needs a goal or a target company, not just a school. Run: npx tsx scripts/smoke-people-to-meet-gate.ts */
import { checker } from "./smoke/check";
import { hasMeetingSignal } from "../src/lib/people-to-meet";

const t = checker();
t.check("only schools set: no signal", !hasMeetingSignal({ aim: null, targetCompanies: [] }));
t.check("blank aim and blank company: no signal", !hasMeetingSignal({ aim: "  ", targetCompanies: [" "] }));
t.check("a goal is a signal", hasMeetingSignal({ aim: "engineering", targetCompanies: [] }));
t.check("one target company is a signal", hasMeetingSignal({ aim: null, targetCompanies: ["Stripe"] }));
t.done("smoke-people-to-meet-gate");
