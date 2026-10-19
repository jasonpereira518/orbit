/**
 * What happens to a Stripe customer when its Orbit account is deleted (audit M-09).
 *
 * The customer is NOT deleted: Stripe's record of charges, invoices and refunds is the
 * finance audit trail, and deleting the customer detaches it. Instead its metadata says the
 * account is gone, so an operator looking
 * at it in the dashboard can see why it went quiet. (Nothing in Orbit reads the flag; the
 * account's settings row, the only link to the customer, is deleted by the same purge.)
 * Subscriptions are cancelled separately, before the purge (`src/lib/account-deletion.ts`).
 *
 * No-op without `STRIPE_SECRET_KEY`. The Stripe call is swappable for tests.
 */
export type StripeCustomerRetirer = (customerId: string, deletedAt: Date) => Promise<void>;

const defaultRetirer: StripeCustomerRetirer = async (customerId, deletedAt) => {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const { getStripe } = await import("@/lib/stripe");
  await getStripe().customers.update(customerId, {
    metadata: { orbit_account_deleted: "true", orbit_account_deleted_at: deletedAt.toISOString() },
  });
};

let retirer: StripeCustomerRetirer = defaultRetirer;

export function setStripeCustomerRetirerForTest(next: StripeCustomerRetirer | null) {
  retirer = next ?? defaultRetirer;
}

export async function retireStripeCustomer(customerId: string, now: Date = new Date()): Promise<void> {
  await retirer(customerId, now);
}
