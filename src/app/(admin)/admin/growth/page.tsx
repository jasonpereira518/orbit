import { permanentRedirect } from "next/navigation";

export default function AdminGrowthRedirect() {
  permanentRedirect("/admin/metrics?view=growth");
}
