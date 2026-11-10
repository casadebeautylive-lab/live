"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action-state";

type Props = {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  resetOnSuccess?: boolean;
  successText?: string;
};

/** Form bound to a server action; shows errors inline and refreshes data on success. */
export function ActionForm({ action, children, className, confirm, resetOnSuccess, successText }: Props) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) ref.current?.reset();
      router.refresh();
    }
  }, [state, resetOnSuccess, router]);

  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state?.error && <p className="mt-2 w-full basis-full text-sm text-neg">{state.error}</p>}
      {state?.ok && successText && <p className="mt-2 w-full basis-full text-sm text-pos">{successText}</p>}
    </form>
  );
}
