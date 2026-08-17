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
        <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} syncHost={APP_URL}>
          <App />
        </ClerkProvider>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>
);
