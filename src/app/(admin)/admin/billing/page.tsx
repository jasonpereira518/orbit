import { permanentRedirect } from "next/navigation";

export default function AdminBillingRedirect() {
  permanentRedirect("/admin/metrics?view=revenue");
}
