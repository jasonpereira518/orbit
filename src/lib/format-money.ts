/**
 * Plain money formatters, safe to import from Server Components.
 *
 * These used to live in `components/admin/charts.tsx`, which is a `"use client"` module.
 * Calling a function exported from a client module directly (rather than rendering it as a
 * component) throws at runtime on the server, so every admin page that formatted a dollar
 * figure inline — most of the Money section — was broken. This file has no directive and
 * no imports, so it is safe from both sides of the server/client boundary.
 */

export function formatCents(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) {
    return `$${(dollars / 1000).toFixed(1)}k`;
  }
  // Whole dollars where the cents are zero: every Orbit price is a whole number, and
  // ".00" on all of them reads as a rounding artefact rather than a precise figure.
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function formatMicros(micros: number): string {
  return formatCents(Math.round(micros / 10_000));
}
