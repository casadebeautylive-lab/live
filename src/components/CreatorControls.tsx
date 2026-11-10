"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** Status dropdown that saves as soon as it changes. */
export function StatusSelect({ action, username, value, options, disabled }: { action: Action; username: string; value: string; options: { id: string; label: string }[]; disabled?: boolean }) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form ref={ref} action={formAction}>
      <input type="hidden" name="username" value={username} />
      <select
        name="status"
        defaultValue={value}
        disabled={disabled || pending}
        onChange={() => ref.current?.requestSubmit()}
        className={`input w-full py-1.5 text-xs ${value === "not_contacted" ? "text-gold" : ""}`}
        aria-label="Collaboration status"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {state?.error && <p className="mt-1 text-[11px] text-neg">{state.error}</p>}
    </form>
  );
}

/** Notes that save on blur (only if changed). */
export function NotesField({ action, username, value, disabled }: { action: Action; username: string; value: string; disabled?: boolean }) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState(value);
  useEffect(() => {
    if (state?.ok) setSaved((ref.current?.elements.namedItem("notes") as HTMLTextAreaElement | null)?.value ?? "");
  }, [state]);
  return (
    <form ref={ref} action={formAction}>
      <input type="hidden" name="username" value={username} />
      <textarea
        name="notes"
        defaultValue={value}
        disabled={disabled}
        rows={1}
        placeholder="Notes…"
        onBlur={(e) => {
          if (e.currentTarget.value !== saved) ref.current?.requestSubmit();
        }}
        className="input min-h-[34px] w-full resize-y py-1.5 text-xs"
        aria-label="Notes"
      />
      <div className="h-3 text-[10px] text-faint">{pending ? "Saving…" : state?.error ? <span className="text-neg">{state.error}</span> : state?.ok ? "Saved" : ""}</div>
    </form>
  );
}

/** Copies the outreach message. Never sends anything on TikTok. */
export function CopyMessage({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn w-full py-1.5 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const t = document.createElement("textarea");
          t.value = text;
          document.body.appendChild(t);
          t.select();
          document.execCommand("copy");
          t.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied ✓" : "Copy message"}
    </button>
  );
}
