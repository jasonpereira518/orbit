import Link from "next/link";
import { SPOTS_PER_REFERRAL } from "@/lib/interest-list";

/**
 * What /interest says on the app domain once sign-up is open. Server-only on purpose: the page
 * hands this to the client hero and path as props, so the product name and the /sign-up link
 * never enter the client bundle the waitlist's own host serves (smoke-waitlist-copy).
 */
export function signupOpenHero(hasPass: boolean) {
  return {
    eyebrow: "Orbit is open",
    lead: (
      <>
        Orbit is open —{" "}
        <Link href="/sign-up" className="underline underline-offset-4 hover:text-[#e8f3f1]">
          create a free account
        </Link>{" "}
        to get started. This list is just for launch updates{hasPass ? ", and your place is saved" : ""}.
      </>
    ),
  };
}

export const SIGNUP_OPEN_STOPS = [
  { title: "Join the list", body: "One email address gets you launch updates." },
  {
    title: "Bring friends",
    body: `Each friend who joins through your link moves you up ${SPOTS_PER_REFERRAL} spots.`,
  },
  { title: "Create an account", body: "Orbit is open. Sign up free and you’re in, no invite needed." },
  { title: "You’re in", body: "Start adding the people you know." },
] as const;
