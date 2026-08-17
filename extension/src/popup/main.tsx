import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/chrome-extension";
import { App } from "./App";
import { APP_URL, CLERK_PUBLISHABLE_KEY } from "@/lib/env";
import "@/styles/popup.css";

const root = document.getElementById("root")!;

createRoot(root).render(
  <StrictMode>
    {CLERK_PUBLISHABLE_KEY ? (
      // syncHost shares the session with the Orbit tab the user is already
      // signed into, so there is no separate sign-in inside the extension.
      <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} syncHost={APP_URL}>
        <App />
      </ClerkProvider>
    ) : (
      <App />
    )}
  </StrictMode>
);
