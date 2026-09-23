"use client";

import { useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * Name and picture, straight onto the Clerk user.
 *
 * Mounted only where `clerkOn` is true, so `useUser()` always has a provider above it.
 * Neither change needs reverification — Clerk asks for that on credentials, not on a
 * display name.
 */
export function ProfileForm() {
  const { isLoaded, user } = useUser();
  const fileInput = useRef<HTMLInputElement>(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Seed once, after Clerk loads. Re-seeding on every render would fight the typist.
  if (isLoaded && user && !seeded) {
    setFirst(user.firstName ?? "");
    setLast(user.lastName ?? "");
    setSeeded(true);
  }

  if (!isLoaded) {
    return <div className="h-32 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (!user) return null;

  const dirty = first !== (user.firstName ?? "") || last !== (user.lastName ?? "");
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "You";

  const save = async () => {
    setSaving(true);
    try {
      await user.update({ firstName: first.trim(), lastName: last.trim() });
      toast.success("Name saved");
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setSaving(false);
    }
  };

  const changePhoto = async (file: File | null) => {
    setUploading(true);
    try {
      await user.setProfileImage({ file });
      toast.success(file ? "Photo updated" : "Photo removed");
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar size="lg">
          {user.imageUrl && <AvatarImage src={user.imageUrl} alt="" />}
          <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void changePhoto(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? "Working…" : "Change photo"}
          </Button>
          {user.hasImage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() => void changePhoto(null)}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="account-first">First name</Label>
          <Input
            id="account-first"
            value={first}
            onChange={(e) => setFirst(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="account-last">Last name</Label>
          <Input id="account-last" value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
      </div>

      <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save name"}
      </Button>
    </div>
  );
}
