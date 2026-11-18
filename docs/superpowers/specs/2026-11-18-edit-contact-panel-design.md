# Edit contact panel redesign (Nov 18 2026)

## Why
The Edit contact sheet was one long scroll of about 21 identical boxes. It had no grouping and no colour. Save was buried under Notes, with Delete right below it. Company was free text, and School only suggested values from your own contacts. Jason wants fast, keyboard-first entry and clear grouping. He also wants company and school to be lookups: type, arrow to the closest match, press Enter.

## Decisions
**Jason's calls**
- Look: option A's tinted section cards under option C's brand-coloured header.
- Bluesky and Mastodon are removed outright, including the columns (schema 250, PR 1).
- Company and School are search-and-pick fields.

**Builder's calls**
- **Order:**
  1. Name / Preferred name.
  2. Work and school (teal): Company, Role, School, Location.
  3. Reach (sky): Email, Phone, LinkedIn, Website.
  4. How you met (amber): context pills, When, Details.
  5. Relationship (rose): Strength as 5 dots, Priority pills, Tag chips.
  6. About (neutral): Industry, Shared interests, Notes.
- **Header:**
  - It's a band in the company's brand colour, mixed 62% toward near-black so white text stays legible.
  - It only colours for a brand Orbit knows (`lookupBrand`); otherwise it stays Orbit teal, so a half-typed company never repaints it.
  - It updates live from the form.
- **Actions:**
  - Merge and Delete move into the header's ⋯ menu.
  - Save is pinned to the bottom of the sheet.
  - ⌘/Ctrl+↵ saves from any field.
- **Strength:** it shows empty ("Not rated") until someone actually rates the person. That keeps the existing `strengthRated` rule.
- **Lookup:** it reuses `/api/orgs/suggest`, the same source as onboarding: your own names, then the curated list, then Wikidata. Rows of the field's own kind sort first. School also lists your contacts' schools first, labelled "In your orbit".
- **Scope:**
  - `/contacts/new` gets the sections and lookups but no brand header.
  - Onboarding's compact form is unchanged.
  - No new fields.

## Approaches considered
1. **Restyle the shared `ContactForm` in place (chosen).** It's one form, so `/contacts/new` gets the same faster entry. The sheet adds only its header and the pinned footer, through `renderHeader` and `pinnedActions`.
2. **A separate edit-only form.** That doubles the field and save logic, and the two forms would drift.
3. **Keep the form and only reorder it.** That doesn't fix the "wall of boxes" or the lookup.

## Pieces
- `contacts/org-combobox.tsx`: `OrgCombobox`, the multi-pick chip version that onboarding uses, and `OrgField`, a single-value form field. They share a `useOrgSearch` hook.
- `contacts/contact-form-controls.tsx`: `StrengthDots`, `ChoicePills` and `TagInput`. Each is a radiogroup or a chip text box with full keyboard support.
- `DeleteContactDialog` and `MergeContactDialog`: controlled dialogs with no trigger of their own, opened from the menu.
