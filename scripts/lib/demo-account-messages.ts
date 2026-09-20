/**
 * Console copy for the demo-account scripts, apart from them so a pure smoke can check it
 * without calling Clerk. Never echoes a secret: only the key's instance prefix is shown.
 */
export function clerkInstanceLabel(secretKey: string): "test" | "live" | "unknown" {
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  return "unknown";
}

export function missingDemoUserMessage(email: string, secretKey: string): string {
  const instance = clerkInstanceLabel(secretKey);
  const keyShown = instance === "unknown" ? "<your Clerk secret key>" : `sk_${instance}_…`;
  const where = instance === "unknown" ? "the Clerk instance behind this key" : `the Clerk ${instance} instance behind this key`;
  return [
    `No Clerk user found for ${email} in ${where}.`,
    "Create it first, with the same secret key you just used:",
    `  CLERK_SECRET_KEY=${keyShown} npx tsx scripts/provision-demo-account.ts --email ${email}`,
    "then run this script again.",
  ].join("\n");
}
