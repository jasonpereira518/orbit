import { cookies } from "next/headers";
import { ContactsPageSkeleton } from "@/components/loading/page-skeletons";
import { PEOPLE_NAV_COOKIE } from "@/lib/people-nav";

export default async function ContactsLoading() {
  const jar = await cookies();
  // Skip skeleton when switching from Recruiters via the people toggle.
  if (jar.get(PEOPLE_NAV_COOKIE)?.value === "1") {
    return null;
  }
  return <ContactsPageSkeleton />;
}
