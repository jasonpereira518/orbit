# Pricing v2 — proposed Terms and Privacy edits

**Status: proposal only.** Neither page has been edited, `TERMS_VERSION` (`src/lib/legal.ts`,
currently `2026-09-26`) has not been bumped, and `scripts/legal-pages.lock.json` is untouched.
Every change below needs Jason's approval first.

**Why this blocks shipping:** Privacy §7 says "Orbit never runs AI on its own provider accounts."
That becomes false the moment included AI runs for a Pro or Max account. Included AI therefore
ships **paused in production** (`site_settings.managed_ai_paused` unset reads as paused on
`VERCEL_ENV=production`). It should be switched on from Admin → Money only after these edits are
live.

Once the edits are approved, publish them in one change:

1. Edit both pages.
2. Move `LEGAL_LAST_UPDATED`.
3. Decide on `TERMS_VERSION` (see the last section).
4. Run `npx tsx scripts/smoke-legal-pages.ts --update`.

Line numbers refer to this branch (`claude/pricing-v2`).

---

## Terms — `src/app/(site)/(docs)/terms/page.tsx`

### T1. §4 Your account (line 152): account deletion
- **Now:** "Deleting it erases your Orbit data, cancels an active Orbit Pro subscription, and removes your sign-in."
- **Proposed:** "…cancels an active Orbit Pro or Orbit Max subscription, and removes your sign-in."

### T2. §7 Third-party services and your API keys (lines 240–247): markup
- **Now:** "Where you supply your own API keys, you are contracting directly with that provider… Orbit adds no markup to what your providers charge, and equally takes no responsibility for it."
- **Proposed:** keep that paragraph as it is, since it is still true for keys you supply. Add after it:
  > "Included AI on Orbit Pro and Orbit Max is different: it runs on Orbit's own accounts with those providers, is paid for by your plan and measured in credits (see Plans and payment), and the provider does not bill you."

### T3. §8 AI features (lines 252–269): whose key AI runs on
- **Now:** "On every plan, including Orbit Pro and Orbit Lifetime, AI runs on an API key you supply, and that provider bills you directly."
- **Proposed:**
  > "On the Free Plan and on Orbit Lifetime, AI runs on an API key you supply, and that provider bills you directly. On Orbit Pro and Orbit Max, AI is included: it runs on Orbit's own provider accounts and uses your plan's credits. If you add a key of your own and choose it in Settings, those calls run on your key instead, your provider bills you, and no credits are used."
- **Now:** "Settings shows the last 30 days of AI usage and its estimated cost; the bill itself comes from your provider."
- **Proposed:** "…and its estimated cost. For calls on your own key, the bill itself comes from your provider; included AI shows as credits used."
- Background AI work (search indexing, timeline derivation) also draws on credits for Pro and Max. The code runs background work only while more than half of the allowance remains. Consider saying so:
  > "On Pro and Max, background AI work uses credits too, and pauses once half of the month's credits are used, so what you ask for yourself comes first."

### T4. §10 Plans and payment (lines 294–343): rewrite

**Opening paragraph.** Remove the Lifetime intro-price sentence and the `LIFETIME_*` imports. Proposed text:

> "The Free Plan covers up to {FREE_CONTACT_LIMIT} contacts and costs nothing; AI on it runs on a key you supply. Orbit Pro and Orbit Max are subscriptions, billed monthly or yearly (a year paid up front is two months free), that lift that cap and include AI, along with the other allowances listed on the pricing page. Current prices are on the pricing page and apply from the moment you subscribe. Orbit Lifetime is no longer sold. Accounts that already have it keep it, with every Orbit Max feature and AI on their own key."

**Bullets:**
- **Keep as they are:** "Reaching a limit only stops you adding people", and "Refunds and chargebacks end what they paid for".
- **Cancel whenever you like:** change "Orbit Pro ends" to "your subscription ends". Add a sentence on switching:
  > "Moving from Pro to Max, or from monthly to annual billing, takes effect at once and you pay the difference for the rest of the period; moving from Max to Pro, or from annual to monthly, takes effect when the period you've paid for ends. This applies to annual plans too: cancelling an annual plan ends it at the close of the year already paid for, without a pro-rated refund."
- **Payments are handled by Stripe:** change "Both Orbit Pro and Orbit Lifetime are sold through Stripe" to "Orbit Pro, Orbit Max and credit packs are sold through Stripe".
- **AI, enrichment, and sending costs are separate:** change to
  > "Where a feature runs on your own provider key, that provider bills you directly and no Orbit plan covers it. Included AI on Pro and Max is covered by your plan's credits."

**New bullet: credits.**
> "**Credits.** Included AI is measured in credits: one credit is one cent of the provider's list price for the work done. Your plan's monthly credits reset each month — on an annual plan too, on the same day each month — and do not roll over. When your credits run out, included AI stops until they reset or you add a pack. At most the one request already in progress finishes. Orbit never charges you automatically for more."

**New bullet: credit packs.**
> "**Credit packs.** On Pro and Max you can buy 250 credits for $5. Pack credits are used after your monthly credits, and they do not expire while you're on Pro or Max. If you move to a plan without included AI, unused pack credits are kept but can't be used; they come back if you subscribe to Pro or Max again. If a pack's payment is refunded or reversed after a lost dispute, the pack's unused credits are removed."

**Decision for Jason:** should annual plans have a refund window (for example, 14 days after an annual charge)? The code books no refund on cancellation either way; a refund you issue in Stripe ends the plan, as for monthly.

**Decision for Jason:** are packs refundable? The code revokes unused credits on any refund; it does not decide whether you refund. Suggested wording:
> "Packs are not refundable once any of their credits are used, except where the law requires it or a charge was made in error."

**New bullet: founding pricing.** Only applies to invited accounts. Keep the wording neutral: no scarcity, no countdown.
> "**Founding pricing.** An account created from a beta invitation gets its first paid subscription, if billed monthly, at a founding price for its first three monthly invoices: $2 off Orbit Pro or $4 off Orbit Max. Founding pricing does not apply to annual billing, which is already discounted, and ends if a founding subscription moves to annual billing. If you switch between Pro and Max during those months, the founding price for the new plan applies to the invoices that remain. After that, the regular price applies. Founding pricing applies once per account."

**Keep:** the "Prices may change…" paragraph, unchanged.

**Also check:** the "What Orbit is" section and the HIGHLIGHTS list. Neither mentions prices today; no change needed.

---

## Privacy — `src/app/(site)/(docs)/privacy/page.tsx`

### P1. Processor cards (lines 66–74)
- **Stripe, now:** "Orbit Pro and Orbit Lifetime payments."
- **Stripe, proposed:** "Orbit Pro, Orbit Max and credit pack payments."
- **Google Gemini, OpenAI, Anthropic, now:** "…On the provider and key you choose in Settings."
- **Google Gemini, OpenAI, Anthropic, proposed:** "…On the provider you choose in Settings: on your own key, or — for included AI on Orbit Pro and Orbit Max — on Orbit's account with that provider."
- **Apollo, now:** "…with your Apollo key, or Orbit's on Pro."
- **Apollo, proposed:** "…with your Apollo key, or Orbit's on Pro, Max and Lifetime (up to your plan's monthly enrichments)."

### P2. Google Limited Use paragraph (line 231)
- **Now:** "…the text involved goes to the AI provider you chose, on your own key, only to produce the result you asked for."
- **Proposed:** "…goes to the AI provider you chose — on your own key, or on Pro and Max on Orbit's account with that provider — only to produce the result you asked for."
- **Before publishing:** confirm that Orbit's provider accounts are on API terms that exclude training on inputs. Limited Use requires that Google user data is not used to train models. The paragraph that follows says Orbit does not use it for training, and that must stay true on Orbit's accounts.

### P3. §7 AI processing (lines 325–332): the ship blocker
- **Now:** "On every plan, every call runs on an API key you supply, so the request lands on your own account with that provider and is governed by the retention settings you have agreed with them. Orbit never runs AI on its own provider accounts."
- **Proposed:**
  > "On the Free Plan and Orbit Lifetime, every call runs on an API key you supply, so the request lands on your own account with that provider and is governed by the retention settings you have agreed with them. On Orbit Pro and Orbit Max, AI is included: calls run on Orbit's own accounts with those providers, under Orbit's agreements with them, which do not allow your content to be used to train their models. Providers may keep requests for a limited period for abuse monitoring under those agreements. If you choose your own key on Pro or Max, those calls run on your account instead."
- **Jason to verify:** each provider's retention period on Orbit's accounts. Consider zero-data-retention where it's available, and name the period rather than "a limited period".

### P4. §8 Payments (lines 372–382)
- **Now:** "Orbit Pro and Orbit Lifetime are sold through Stripe."
- **Proposed:** "Orbit Pro, Orbit Max and credit packs are sold through Stripe. Orbit Lifetime is no longer sold."
- **Add to the record sentence:** "…a record of each charge, refund and dispute, and of the credits your plan and packs granted and used…"

### P5. §10 Your choices (line 460)
- **Now:** "…cancels an active Orbit Pro subscription…"
- **Proposed:** "…cancels an active Orbit Pro or Orbit Max subscription…"

### P6. §11 How long data is kept (lines 471–490)
- **Add after the downgrade sentence:**
  > "Unused pack credits are kept while you're on a plan that can't use them, and come back if you resubscribe."
- **In the account-deletion sentence, add:** "…Orbit's accounting record of charges, refunds and credit packs, with your account id removed…". This matches the code: the purge anonymises credit grants rather than deleting them, because they back the pack-liability figure.

---

## TERMS_VERSION: Jason's call

The changes are material:
- a new paid feature;
- Orbit becomes a processor route for AI content;
- new billing terms (credits, packs, founding pricing).

**Recommendation:** bump `TERMS_VERSION` and `LEGAL_LAST_UPDATED` together, so existing accounts are asked to re-accept, and publish both before switching included AI on. Leaving the version unchanged would ship under the old consent, and the lock smoke is there to make that a deliberate choice.
