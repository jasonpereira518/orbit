/**
 * A wrong `?token=` on /api/health is a 401, not a shallow 200 that looks healthy.
 *
 * Run: npx tsx scripts/smoke-health-token.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { GET } from "../src/app/api/health/route";
import { healthCacheControl } from "../src/lib/health";
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
  check(
    "a query token is refused where query tokens are not allowed (production)",
    healthTokenState(req(`?token=${TOKEN}`), { allowQuery: false }) === "invalid"
  );
  check(
    "a bearer still opens the deep view where query tokens are not allowed",
    healthTokenState(req("", `Bearer ${TOKEN}`), { allowQuery: false }) === "valid"
  );

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

  // A monitor polling the shallow view must be answerable by the CDN, or it keeps a function and
  // the database busy all month. Nothing else may be cached.
  console.log("\nCaching...");
  const cacheControl = (res: Response) => res.headers.get("cache-control") ?? "";
  const seconds = Number(/^public, s-maxage=(\d+)$/.exec(cacheControl(shallow))?.[1]);
  check("a healthy shallow answer is CDN-cached, at most to two minutes past the next tick", seconds > 120 && seconds <= 1920, cacheControl(shallow));
  check("and varies on the bearer", shallow.headers.get("vary") === "Authorization", String(shallow.headers.get("vary")));
  check("the deep view is never cached", cacheControl(deep) === "no-store", cacheControl(deep));
  check("a refused token is never cached", cacheControl(wrong) === "no-store", cacheControl(wrong));
  const okAt = (iso: string) => healthCacheControl({ deep: false, status: "ok" }, new Date(iso));
  check("one minute past a tick → cached until :32", okAt("2026-12-20T19:01:00Z") === "public, s-maxage=1860", okAt("2026-12-20T19:01:00Z"));
  check("ten seconds before a tick → cached until two minutes after it", okAt("2026-12-20T19:29:50Z") === "public, s-maxage=130", okAt("2026-12-20T19:29:50Z"));
  check(
    "down and degraded answers are never cached",
    (["down", "degraded"] as const).every((status) => healthCacheControl({ deep: false, status }, new Date()) === "no-store")
  );

  delete process.env.HEALTH_TOKEN;
  check("a token presented while HEALTH_TOKEN is unset → 401", (await GET(req("?token=anything"))).status === 401);
  check("no token while unset → shallow 200", (await GET(req())).status === 200);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll health-token checks passed.");
});
