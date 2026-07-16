import { auth, currentUser } from "@clerk/nextjs/server";

export function isClerkConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

export async function requireUserId(): Promise<string> {
  if (!isClerkConfigured()) {
    return "demo-user";
  }

  try {
    const { userId } = await auth();
    if (userId) return userId;
  } catch {
    // Middleware missing or Clerk runtime issue
  }

  throw new Error("Unauthorized");
}

export async function getCurrentUserProfile() {
  if (!isClerkConfigured()) {
    return {
      id: "demo-user",
      name: "Demo User",
      email: "demo@orbit.local",
      imageUrl: undefined as string | undefined,
    };
  }

  try {
    const user = await currentUser();
    if (user) {
      return {
        id: user.id,
        name: user.fullName || user.firstName || "You",
        email: user.primaryEmailAddress?.emailAddress ?? "",
        imageUrl: user.imageUrl,
      };
    }
  } catch {
    // ignore
  }

  return {
    id: "demo-user",
    name: "Demo User",
    email: "demo@orbit.local",
    imageUrl: undefined as string | undefined,
  };
}
