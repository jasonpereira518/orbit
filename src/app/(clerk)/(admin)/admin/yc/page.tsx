import { redirect } from "next/navigation";

/**
 * `/admin/yc` has no content of its own — it's the landing spot the YC-mode toggle pushes
 * to. Send it straight to the runway tab. Admin access is already gated by the layout above.
 */
export default function AdminYcIndexPage() {
  redirect("/admin/yc/runway");
}
