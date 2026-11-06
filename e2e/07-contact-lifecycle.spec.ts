import { expect, test } from "@playwright/test";
import { createContact, ensureOnboarded, untilHydrated } from "./helpers";

// Create → edit → export → delete, through the UI a person uses, with the export read back
// after each step. The export is the one place that shows everything stored about a
// contact, so it is the check that an edit really landed and a delete really removed.
test("a contact can be edited, shows up in the export, and is gone after delete", async ({ page }) => {
  const name = "Radia Perlman";
  const company = "Spanning Tree Labs";
  await ensureOnboarded(page);
  await createContact(page, name);
  const profileUrl = page.url();

  // The edit sheet, by its own title: `next dev` can put its own dialog on the page too.
  const sheet = page.getByRole("dialog", { name: `Edit ${name}` });
  // Opening is retried until hydrated, but never clicks once the sheet is up: an open modal
  // hides the page's Edit button, and a retry clicking it would wait out the whole timeout.
  const openEditSheet = () =>
    untilHydrated(
      async () => {
        if (await sheet.isVisible()) return;
        await page.getByRole("button", { name: "Edit", exact: true }).first().click({ timeout: 5_000 });
      },
      () => expect(sheet).toBeVisible({ timeout: 5_000 })
    );

  // Edit: the sheet's form is the same ContactForm as /contacts/new, in "Save changes" mode.
  await openEditSheet();
  const companyInput = sheet.getByPlaceholder("Amazon Web Services (AWS)");
  await companyInput.fill(company);
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText(company).first()).toBeVisible();

  // The export holds the edited contact. Same session as the page, so the route sees this account.
  const before = await page.request.get("/api/export");
  expect(before.status()).toBe(200);
  const exported = await before.text();
  expect(exported).toContain(name);
  expect(exported).toContain(company);

  // Delete from the same sheet, through its confirm dialog.
  await page.goto(profileUrl);
  await openEditSheet();
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: `Delete ${name}?` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete contact" }).click();
  await expect(page).toHaveURL(/\/contacts$/, { timeout: 30_000 });

  // Gone from the profile and from the export. The profile is checked as rendered, not by
  // status: a streamed App Router page that calls notFound() still answers 200.
  await page.goto(profileUrl);
  await expect(page.getByRole("heading", { level: 1, name })).toHaveCount(0);
  await expect(page.getByText(company)).toHaveCount(0);
  const after = await page.request.get("/api/export");
  expect(after.status()).toBe(200);
  // The contact row is gone. Its company is a separate `companies` row and stays.
  const exportAfter = (await after.json()) as { categories: { contacts: { contacts: Array<{ full_name: string }> } } };
  expect(exportAfter.categories.contacts.contacts.map((c) => c.full_name)).not.toContain(name);
  expect(JSON.stringify(exportAfter)).not.toContain(name);
});
