import { ContactForm } from "@/components/contacts/contact-form";

export default function NewContactPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
          Add contact
        </h1>
        <p className="mt-1 text-muted-foreground">
          Quick manual entry. Prefer{" "}
          <a href="/capture" className="text-[#0f3d3e] underline">
            AI capture
          </a>{" "}
          for messy notes.
        </p>
      </div>
      <ContactForm />
    </div>
  );
}
