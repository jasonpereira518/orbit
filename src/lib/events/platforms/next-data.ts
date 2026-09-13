/**
 * Reading the JSON a Next.js page ships to its own client.
 *
 * Luma, Partiful and Meetup are all Next apps, and each embeds the event it is rendering as
 * JSON in a `__NEXT_DATA__` script tag. That JSON is strictly better than the JSON-LD beside
 * it: it carries the platform's own event id, the host line-up with social handles, and (on
 * Luma) the guests the host chose to feature on the page.
 *
 * ## Shape-matching, not path-matching
 *
 * The obvious implementation reads `data.props.pageProps.initialData.data.event`. That path is
 * an implementation detail of a framework's build, not an interface, and it changes without
 * notice — the first Next upgrade would silently return nothing, with no error anywhere.
 *
 * So nothing here hard-codes a path. `findNode` walks the tree looking for an object with the
 * SHAPE of an event — an `api_id` that starts `evt-`, say — which survives the JSON being
 * moved, wrapped or renamed around it. When even that fails the caller records a zero-yield
 * error event, so markup drift shows up in telemetry rather than as a quiet absence.
 *
 * Pure: no network, no database, no DOM.
 */

/** Enough for a large event page; the fetcher's own cap is what actually bounds the input. */
const MAX_JSON_BYTES = 2_000_000;

/**
 * The `__NEXT_DATA__` payload, or null.
 *
 * Deliberately tolerant about the tag: attribute order varies, and the type attribute is
 * sometimes absent. Deliberately intolerant about size and validity — a truncated body (the
 * fetcher caps what it reads) produces invalid JSON, and guessing at half a document is how a
 * parser starts inventing events.
 */
export function readNextData(html: string): unknown | null {
  const start = html.search(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>/i);
  if (start < 0) return null;
  const open = html.indexOf(">", start);
  if (open < 0) return null;
  const end = html.indexOf("</script>", open);
  if (end < 0) return null;
  const raw = html.slice(open + 1, end);
  if (raw.length > MAX_JSON_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Any embedded JSON blob a page ships, for platforms that do not use `__NEXT_DATA__`. */
export function readJsonScript(html: string, id: string): unknown | null {
  const pattern = new RegExp(`<script[^>]*id=["']${id}["'][^>]*>`, "i");
  const hit = pattern.exec(html);
  if (!hit) return null;
  const open = html.indexOf(">", hit.index);
  const end = html.indexOf("</script>", open);
  if (open < 0 || end < 0) return null;
  try {
    return JSON.parse(html.slice(open + 1, end));
  } catch {
    return null;
  }
}

type Node = Record<string, unknown>;

function isObject(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first node anywhere in the tree that matches `predicate`.
 *
 * Breadth-first, so the outermost match wins — a nested copy of an event (Luma embeds related
 * events inside the one being viewed) must never beat the page's own subject. Bounded by depth
 * and by total nodes visited: this walks attacker-influenced JSON.
 */
export function findNode(
  root: unknown,
  predicate: (node: Node) => boolean,
  options: { maxDepth?: number; maxNodes?: number } = {}
): Node | null {
  const maxDepth = options.maxDepth ?? 14;
  const maxNodes = options.maxNodes ?? 20_000;
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0) {
    const { value, depth } = queue.shift()!;
    if (++visited > maxNodes || depth > maxDepth) continue;

    if (Array.isArray(value)) {
      for (const item of value) queue.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isObject(value)) continue;
    if (predicate(value)) return value;
    for (const item of Object.values(value)) queue.push({ value: item, depth: depth + 1 });
  }
  return null;
}

/** Every node matching `predicate`, up to `limit`. Same bounds and ordering as `findNode`. */
export function findNodes(
  root: unknown,
  predicate: (node: Node) => boolean,
  options: { limit?: number; maxDepth?: number; maxNodes?: number } = {}
): Node[] {
  const limit = options.limit ?? 50;
  const maxDepth = options.maxDepth ?? 14;
  const maxNodes = options.maxNodes ?? 20_000;
  const out: Node[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && out.length < limit) {
    const { value, depth } = queue.shift()!;
    if (++visited > maxNodes || depth > maxDepth) continue;

    if (Array.isArray(value)) {
      for (const item of value) queue.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isObject(value)) continue;
    if (predicate(value)) {
      out.push(value);
      // Not descending into a match: a person node's own fields are not more people.
      continue;
    }
    for (const item of Object.values(value)) queue.push({ value: item, depth: depth + 1 });
  }
  return out;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * A LinkedIn handle as the profile URL the rest of Orbit stores.
 *
 * Platforms store these three ways — a bare handle, a `/in/handle` path, a full URL — and
 * `attendeeIdentityKey` keys on the string it is given, so normalising here is what keeps one
 * person from becoming three roster rows.
 */
export function linkedinUrlFrom(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    return /linkedin\.com\/in\//i.test(raw) ? raw : null;
  }
  const handle = raw.replace(/^\/?(?:in\/)?/i, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9\-_%À-ÿ.]{3,100}$/.test(handle)) return null;
  return `https://www.linkedin.com/in/${handle}`;
}

/** An X/Twitter handle, without the `@` and without a URL wrapper. */
export function xHandleFrom(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const fromUrl = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})/i.exec(raw);
  const handle = fromUrl ? fromUrl[1]! : raw.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}
