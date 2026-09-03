import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/chrome-extension";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { APP_URL, CLERK_PUBLISHABLE_KEY } from "@/lib/env";
import "@/styles/panel.css";

const root = document.getElementById("root")!;

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      {CLERK_PUBLISHABLE_KEY ? (
        // syncHost shares the session with the Orbit tab the user is already
        // signed into, so there is no separate sign-in inside the extension.
        // __experimental_syncHostListener wires up the cookie-change listener
        // that actually notices a sign-in completed in that tab — without it
        // the panel (which stays mounted across navigation) never re-checks.
        <ClerkProvider
          publishableKey={CLERK_PUBLISHABLE_KEY}
          syncHost={APP_URL}
          __experimental_syncHostListener
        >
          <App />
        </ClerkProvider>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>
);
