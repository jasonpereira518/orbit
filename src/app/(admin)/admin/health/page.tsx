import { permanentRedirect } from "next/navigation";

export default function AdminHealthRedirect() {
  permanentRedirect("/admin/systems");
}
