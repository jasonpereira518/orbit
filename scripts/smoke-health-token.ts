/**
 * A wrong `?token=` on /api/health is a 401, not a shallow 200 that looks healthy.
 *
 * Run: npx tsx scripts/smoke-health-token.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { GET } from "../src/app/api/health/route";
import { healthTokenState } from "../src/lib/internal-auth";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const TOKEN = "smoke-health-token-value-0123456789";
const req = (qs = "", authorization?: string) =>
  new Request(`http://localhost/api/health${qs}`, { headers: authorization ? { authorization } : {} });

run(async () => {
  process.env.HEALTH_TOKEN = TOKEN;
  console.log("healthTokenState...");
  check("no token → absent", healthTokenState(req()) === "absent");
  check("right ?token → valid", healthTokenState(req(`?token=${TOKEN}`)) === "valid");
  check("wrong ?token → invalid", healthTokenState(req("?token=wrong")) === "invalid");
  check("empty ?token= → invalid", healthTokenState(req("?token=")) === "invalid");
  check("right bearer, no param → valid", healthTokenState(req("", `Bearer ${TOKEN}`)) === "valid");
  check("wrong bearer, no param → absent (unchanged)", healthTokenState(req("", "Bearer nope")) === "absent");

  console.log("\nThe route...");
  const wrong = await GET(req("?token=wrong"));
  const wrongBody = (await wrong.json()) as Record<string, unknown>;
  check("wrong token → 401", wrong.status === 401, String(wrong.status));
  check("the 401 says nothing about the system", !("schema" in wrongBody) && !("db" in wrongBody), JSON.stringify(wrongBody));
  const shallow = await GET(req());
  const shallowBody = (await shallow.json()) as Record<string, unknown>;
  check("no token → shallow 200", shallow.status === 200 && !("config" in shallowBody), JSON.stringify(shallowBody));
  const deep = await GET(req(`?token=${TOKEN}`));
  check("right token → the deep view", deep.status === 200 && "config" in ((await deep.json()) as Record<string, unknown>));

  delete process.env.HEALTH_TOKEN;
  check("a token presented while HEALTH_TOKEN is unset → 401", (await GET(req("?token=anything"))).status === 401);
  check("no token while unset → shallow 200", (await GET(req())).status === 200);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll health-token checks passed.");
});
