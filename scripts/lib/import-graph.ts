import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * The repo-local modules a server entry evaluates: the transitive graph of its static
 * imports and `export … from` re-exports, following relative and `@/` specifiers only (bare
 * packages are out of scope). Type-only imports are skipped (erased at compile time), and a
 * `"use client"` module is included but not followed — its children are client code.
 *
 * Returns each reached file (repo-relative) mapped to the file that first imported it, so a
 * failing guard can print the chain rather than just the name.
 */
export function serverImportGraph(entryFile: string): Map<string, string | null> {
  const root = resolve(".");
  const entry = resolve(entryFile);
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];

  const resolveSpecifier = (fromFile: string, specifier: string): string | null => {
    let base: string;
    if (specifier.startsWith("@/")) base = join(root, "src", specifier.slice(2));
    else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
    else return null;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  while (queue.length) {
    const file = queue.shift()!;
    const source = readFileSync(file, "utf8");
    if (file !== entry && /^\s*["']use client["']/.test(source)) continue;
    const sf = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    for (const stmt of sf.statements) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly) specifier = stmt.moduleSpecifier;
      else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) specifier = stmt.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const resolved = resolveSpecifier(file, specifier.text);
      if (resolved && !parent.has(resolved)) {
        parent.set(resolved, file);
        queue.push(resolved);
      }
    }
  }

  return new Map([...parent].map(([file, from]) => [relative(root, file), from && relative(root, from)]));
}

/** The import chain from the graph's entry to `file`, entry first. */
export function chainTo(graph: Map<string, string | null>, file: string): string[] {
  const chain: string[] = [];
  for (let at: string | null | undefined = file; at; at = graph.get(at)) chain.unshift(at);
  return chain;
}
