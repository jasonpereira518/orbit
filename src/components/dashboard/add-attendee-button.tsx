"use client";


import { useRouter } from "next/navigation";
import { useGuardedTransition } from "@/lib/single-flight";
import { UserPlus } from "lucide-react";
import { createContact } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/** "+ Add" beside a meeting guest who is not a contact yet; the refresh re-renders them with a photo. */
export function AddAttendeeButton({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [pending, start] = useGuardedTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 gap-1 px-2 text-xs"
      disabled={pending}
      aria-label={`Add ${name || email} to your contacts`}
      onClick={() =>
        start(async () => {
          try {
            await createContact({ fullName: name || email.split("@")[0], email });
            toast.success("Added to your orbit");
            router.refresh();
          } catch (err) {
            toast.error(friendlyError(err, TOAST_COPY.saveFailed));
          }
        })
      }
    >
      <UserPlus className="size-3.5" aria-hidden />
      Add
    </Button>
  );
}
