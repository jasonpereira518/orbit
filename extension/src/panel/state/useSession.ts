import { useAuth } from "@clerk/chrome-extension";
import { CLERK_PUBLISHABLE_KEY, DEV_SECRET } from "@/lib/env";

export type Session = {
  isLoaded: boolean;
  isSignedIn: boolean;
  getToken: () => Promise<string | null>;
};

function useClerkSession(): Session {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  return {
    isLoaded,
    isSignedIn: Boolean(isSignedIn),
    getToken: () => getToken(),
  };
}

/**
 * Local dev against a server with no Clerk keys. The shared secret rides in a
 * header instead; the server ignores it outside development.
 */
function useDevSession(): Session {
  return {
    isLoaded: true,
    isSignedIn: Boolean(DEV_SECRET),
    getToken: async () => null,
  };
}

/**
 * Picked once at build time from a constant, so the hook identity never changes
 * between renders — conditional hooks are only a problem when the condition is.
 */
export const useSession: () => Session = CLERK_PUBLISHABLE_KEY
  ? useClerkSession
  : useDevSession;
