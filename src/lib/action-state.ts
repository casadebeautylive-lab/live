import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

export type ActionState = { ok?: boolean; error?: string; at?: number } | null;

/** Run a server action body, turning failures into a message the form can show. */
export async function run(fn: (form: FormData) => Promise<void>, form: FormData): Promise<ActionState> {
  try {
    await fn(form);
    return { ok: true, at: Date.now() };
  } catch (e) {
    unstable_rethrow(e); // let redirect()/notFound() through
    if (e instanceof ZodError) return { error: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), at: Date.now() };
    return { error: e instanceof Error ? e.message : "Something went wrong", at: Date.now() };
  }
}
