/**
 * The class that carries the console's monochrome palette.
 *
 * Defined in `src/app/globals.css` as `.admin-theme` — a block of token overrides, not a
 * set of colour utilities. Everything inside this class re-colours automatically because
 * the admin tree resolves every colour through a custom property.
 *
 * IT MUST BE APPLIED TO PORTAL SURFACES TOO. `Dialog`, `DropdownMenu` and `Tooltip` render
 * into `document.body`, which is outside the shell's subtree — so a dialog opened from the
 * console would otherwise inherit the *product's* teal palette and look like it belongs to
 * a different application. There is no way to catch that automatically; the fix is to put
 * this class on every portal surface the console mounts.
 *
 * THIS IS THE THING THAT SILENTLY REGRESSES. A dialog added later will look correct in
 * development if the developer only ever opens it in light mode, and wrong in the product's
 * palette everywhere else. `scripts/smoke-admin-theme.ts` asserts every portal surface
 * under `src/components/admin/` carries it.
 */
export const ADMIN_THEME_CLASS = "admin-theme";
