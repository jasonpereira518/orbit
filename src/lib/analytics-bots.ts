/**
 * Bot detection for traffic analytics.
 *
 * The beacon runs in JavaScript on a rendered page, so the great majority of crawlers
 * never reach `POST /api/track` at all — this list only has to catch what is left:
 * headless browsers, uptime probes, and the scripted clients that do execute JS.
 *
 * Matches are FLAGGED, NOT REJECTED. `page_views.is_bot` keeps the row and every aggregate
 * filters it out, so a crawler wave shows up as a crawler wave instead of a quiet week —
 * and a false positive can be found and fixed rather than having silently deleted real
 * traffic.
 */
const BOT_PATTERNS: readonly RegExp[] = [
  /bot\b/i,
  /crawler|spider|scraper/i,
  /headless/i,
  /phantomjs|puppeteer|playwright|selenium|webdriver/i,
  /curl\/|wget\/|python-requests|axios\/|node-fetch|go-http-client|okhttp/i,
  /lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|statuscake/i,
  /slackbot|discordbot|telegrambot|whatsapp|twitterbot|facebookexternalhit|linkedinbot/i,
  /preview|prerender|screenshot/i,
];

/** True when the user agent looks automated. Empty agents count as bots: a real browser sends one. */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (!ua) return true;
  return BOT_PATTERNS.some((re) => re.test(ua));
}
