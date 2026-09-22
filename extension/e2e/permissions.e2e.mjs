/**
 * The permission model, end to end, against the REAL built extension.
 *
 *   npm run e2e        (builds dist-e2e first)
 *
 * Every check here is a user-visible promise of sub-project 1:
 *
 *   1. One click on the icon opens the panel AND reads the page — on a site
 *      Orbit holds no standing permission for. (Before: a grant wall.)
 *   2. Switching to a tab nobody clicked shows the hint — never the previous
 *      person beside a different page. (Before: the old person stayed.)
 *   3. Clicking the icon on that tab, with the panel already open, reads it.
 *   4. Browsing within the same site keeps following, with no click.
 *   5. Leaving for another site drops the grant, and the panel says so.
 *   6. Going back to a tab that was clicked earlier reads it again.
 *   7–9. Right-click: a profile link shows that person from the link alone; a
 *      link that isn't a profile says so; selected text opens a note. (The
 *      menu click itself can't be driven over CDP; everything after it is.)
 *
 * The build talks to an unreachable API on purpose (see build:e2e) — none of
 * this depends on the server, and the test must never touch a real account.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchWithExtension } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = process.env.E2E_EXTENSION_DIR ?? join(HERE, "..", "dist-e2e");
const PORT = 4318;

/** A person page the generic adapter can name, via JSON-LD. */
const personPage = (name) => `<!doctype html><html><head><title>${name}</title>
<script type="application/ld+json">{"@type":"Person","name":"${name}","jobTitle":"Engineer"}</script>
</head><body><main><h1>${name}</h1><p>Profile page for the e2e test.</p></main></body></html>`;

const PAGES = {
  "/avery": personPage("Avery Quill"),
  "/blake": personPage("Blake Harrow"),
  "/casey": personPage("Casey Linden"),
};
const server = createServer((req, res) => {
  const body = PAGES[req.url.split("?")[0]];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
  res.end(body ?? "not found");
}).listen(PORT);

// Two hosts on one server are two ORIGINS — which is what activeTab tracks.
const SITE_ONE = `http://localhost:${PORT}`;
const SITE_TWO = `http://127.0.0.1:${PORT}`;
const HINT = "Click the Orbit icon to read this tab";

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n       panel said: ${JSON.stringify(detail.slice(0, 160))}` : ""}`);
  if (!ok) failures++;
}

const chrome = await launchWithExtension(EXTENSION);
try {
  console.log("1. one click opens the panel and reads the page");
  await chrome.openTab("T", `${SITE_ONE}/avery`);
  await chrome.activate("T");
  check("no panel before the click", (await chrome.panelText()) === null);
  await chrome.clickAction("T");
  let r = await chrome.waitForPanel((t) => t.includes("Avery Quill"));
  check("the panel names the person on the page", r.ok, r.text);
  check("…and shows no grant wall or hint", r.ok && !r.text.includes(HINT), r.text);

  console.log("2. an unclicked tab shows the hint, never the previous person");
  await chrome.openTab("U", `${SITE_TWO}/blake`);
  await chrome.activate("U");
  r = await chrome.waitForPanel((t) => t.includes(HINT));
  check("the panel asks for a click", r.ok, r.text);
  check("…and no longer shows Avery", r.ok && !r.text.includes("Avery Quill"), r.text);

  console.log("3. clicking the icon with the panel already open reads the tab");
  await chrome.clickAction("U");
  r = await chrome.waitForPanel((t) => t.includes("Blake Harrow"));
  check("the panel names Blake", r.ok, r.text);

  console.log("4. browsing within the same site keeps following, no click");
  await chrome.navigate("U", `${SITE_TWO}/casey`);
  r = await chrome.waitForPanel((t) => t.includes("Casey Linden"));
  check("the panel follows to Casey", r.ok, r.text);

  console.log("5. leaving for another site drops the grant");
  await chrome.navigate("U", `${SITE_ONE}/blake`);
  r = await chrome.waitForPanel((t) => t.includes(HINT));
  check("the panel asks for a click again", r.ok, r.text);
  check("…and doesn't keep showing Casey", r.ok && !r.text.includes("Casey Linden"), r.text);

  console.log("6. a tab clicked earlier is still readable");
  await chrome.activate("T");
  r = await chrome.waitForPanel((t) => t.includes("Avery Quill"));
  check("back on the first tab, the panel names Avery", r.ok, r.text);

  console.log("7. right-click a profile link: that person, from the link alone");
  await chrome.sendIntent({ kind: "link", linkUrl: "https://www.linkedin.com/in/dana-wells/?trk=x" });
  r = await chrome.waitForPanel((t) => t.includes("dana-wells"));
  check("the panel shows the linked person", r.ok, r.text);
  check("…not the person on the tab", r.ok && !r.text.includes("Avery Quill"), r.text);

  console.log("8. right-click a link that isn't a profile");
  await chrome.sendIntent({ kind: "link", linkUrl: "https://example.com/about" });
  r = await chrome.waitForPanel((t) => t.includes("isn't a profile Orbit can look up"));
  check("the panel says so, instead of guessing", r.ok, r.text);

  console.log("9. right-click selected text: save it as a note");
  await chrome.sendIntent({ kind: "selection", text: "Met at the Stripe offsite — hiring for infra" });
  r = await chrome.waitForPanel((t) => t.includes("Save to Orbit as a note"));
  check("the panel opens the note", r.ok, r.text);
  check("…quoting what was selected", r.ok && r.text.includes("Met at the Stripe offsite"), r.text);
} finally {
  await chrome.close();
  server.close();
}

if (failures) {
  console.error(`\npermissions e2e: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\npermissions e2e: all checks passed");
process.exit(0);
