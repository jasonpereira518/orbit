import { RecruitersPageSkeleton } from "@/components/loading/page-skeletons";
import { PeopleNavFallback } from "@/components/contacts/people-nav-fallback";

export default function RecruitersLoading() {
  return (
    <PeopleNavFallback
      active="recruiters"
      title="Recruiters"
      subtitle="Every recruiter you've talked to — and, if you share, the ones everyone else has."
      skeleton={<RecruitersPageSkeleton />}
    />
  );
}
