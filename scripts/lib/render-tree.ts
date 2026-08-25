/**
 * Resolving a server component tree far enough to assert on it.
 *
 * WHY THIS EXISTS. The admin pages start their queries and hand the promises to async
 * sections behind `<Suspense>`, so calling a page function no longer runs its loaders —
 * it returns a shell whose children have not been invoked. Every render smoke test that
 * asserted "the screen renders" would still pass against a page whose every panel throws,
 * which is worse than having no test at all.
 *
 * `renderDeep` walks the returned element tree and invokes the async components in it,
 * which is what actually forces the loaders to run and the panels to build.
 *
 * WHAT IT DELIBERATELY DOES NOT INVOKE: synchronous function components. In this repo
 * that set is "use client" components plus small presentational helpers, and calling a
 * client component outside React would run its hooks and throw for reasons that have
 * nothing to do with the page being correct. Async-ness is the discriminator because
 * every server section here is `async` and no client component ever is.
 *
 * Suspense boundaries resolve to their CHILDREN, not their fallback — the fallback is the
 * placeholder, and asserting against placeholder text would be the same false pass this
 * file exists to prevent.
 */

type El = {
  type?: unknown;
  props?: Record<string, unknown>;
};

function isElement(node: unknown): node is El {
  return typeof node === "object" && node !== null && "type" in node;
}

function isAsync(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn as { constructor?: { name?: string } }).constructor?.name ===
      "AsyncFunction"
  );
}

/**
 * Invoke every async server component in the tree, depth-first.
 *
 * Returns a plain nested structure suitable for `textOf`. A section that throws is left
 * to propagate: a panel whose loader rejects is exactly the failure worth catching.
 */
export async function renderDeep(node: unknown): Promise<unknown> {
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return Promise.all(node.map(renderDeep));
  if (!isElement(node)) return node;

  const props = node.props ?? {};

  if (isAsync(node.type)) {
    const produced = await (node.type as (p: unknown) => Promise<unknown>)(props);
    return renderDeep(produced);
  }

  // Not async: a host element, a client component, a Suspense boundary, or a plain
  // presentational function. Recurse through its children so nested async sections are
  // still reached, and leave the node itself alone.
  const resolved: Record<string, unknown> = { ...props };

  // DROP THE FALLBACK. `textOf` walks every prop, so a Suspense fallback's text would
  // otherwise land in the output — and since a skeleton fallback carries the same panel
  // title as the panel it stands in for, every "did this panel render?" assertion would
  // pass against a page that resolved nothing. Once the children are resolved the
  // fallback is by definition not what was shown.
  delete resolved.fallback;

  if ("children" in props) resolved.children = await renderDeep(props.children);
  return { ...node, props: resolved };
}

/** Flatten a (already resolved) element tree to the strings it would render. */
export function textOf(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  const props = node.props ?? {};
  for (const value of Object.values(props)) textOf(value, out);
  return out;
}

/** Convenience: run a page function and resolve everything it produced. */
export async function renderPage(
  page: (...args: never[]) => unknown,
  ...args: never[]
): Promise<unknown> {
  return renderDeep(await page(...args));
}
