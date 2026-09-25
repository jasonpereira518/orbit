/**
 * Pins the PKCE derivation and the state cookie.
 *
 * The RFC 7636 appendix-B vector is here because a subtly wrong challenge fails only at the
 * exchange — in a browser, against a live service, with no local signal at all.
 */
import { challengeFor, createVerifier, decodeState, encodeState } from "../src/lib/openrouter-oauth";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// RFC 7636 appendix B.
check(
  "S256 matches the RFC test vector",
  challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") ===
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
);
check("a verifier is URL-safe", /^[A-Za-z0-9\-._~]+$/.test(createVerifier()));
check("a verifier is long enough for RFC 7636", createVerifier().length >= 43);
check("two verifiers differ", createVerifier() !== createVerifier());

const state = encodeState({ userId: "user_123", verifier: "abc", returnTo: "/settings?integration=ai" });
const round = decodeState(state);
check("state round-trips the user", round?.userId === "user_123");
check("state round-trips the verifier", round?.verifier === "abc");
check("state round-trips the return path", round?.returnTo === "/settings?integration=ai");
check("a malformed state decodes to null rather than throwing", decodeState("nonsense") === null);
check("an off-site returnTo is refused", decodeState(encodeState({ userId: "u", verifier: "v", returnTo: "https://evil.example" }))?.returnTo !== "https://evil.example");

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
