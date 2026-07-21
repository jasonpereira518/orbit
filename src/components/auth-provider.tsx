import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { clerkAppearance } from "@/lib/clerk-appearance";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const configured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  if (!configured) {
    return <>{children}</>;
  }

  return (
    <ClerkProvider
      appearance={{
        // shadcn adapts to light/dark via Orbit CSS variables + `.dark`
        theme: shadcn,
        ...clerkAppearance,
      }}
    >
      {children}
    </ClerkProvider>
  );
}
