/** Regenerate src/app/site-sources.css. Run: npm run css:site — see scripts/lib/site-css-sources.ts. */
import { writeFileSync } from "node:fs";
import { SITE_SOURCES_FILE, siteCssSourcesText } from "./lib/site-css-sources";

writeFileSync(SITE_SOURCES_FILE, siteCssSourcesText());
console.log(`wrote ${SITE_SOURCES_FILE}`);
