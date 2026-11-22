/**
 * Where the floating Ask bar shows (src/lib/ask-bar-events.ts). On /radar it hides until
 * Radar is turned on: over the Turn on screen it covers the button on a short viewport.
 */
import { checker } from "./smoke/check";
import { showAskBarFor } from "../src/lib/ask-bar-events";

const t = checker();
const base = { tourActive: false, chatHidden: false, radarOn: false };
const show = (p: string, f: Partial<typeof base> = {}) => showAskBarFor(p, { ...base, ...f });

t.check("/radar, Radar off: hidden", show("/radar") === false);
t.check("/radar, Radar on: shown", show("/radar", { radarOn: true }) === true);
t.check("/radar/ sub-path, Radar off: hidden", show("/radar/x") === false);
t.check("/dashboard: shown", show("/dashboard") === true);
t.check("/contacts/abc: shown (Radar off)", show("/contacts/abc") === true);
t.check("/radarish is not /radar", show("/radarish") === true);
for (const p of ["/onboarding", "/chat", "/settings", "/settings/billing", "/graph", "/graph/x", "/reminders", "/knowledge"]) {
  t.check(`${p}: hidden`, show(p, { radarOn: true }) === false);
}
t.check("tour active: hidden", show("/dashboard", { tourActive: true }) === false);
t.check("chat hidden by operator: hidden", show("/dashboard", { chatHidden: true }) === false);

t.done("ask bar visibility smoke tests");
