"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, requireWriter, supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { localToUtc } from "@/lib/dates";
import { run, type ActionState } from "@/lib/action-state";

const money = z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "Enter an amount like 12.50");
const CATEGORIES = ["giveaways", "advertising", "packaging", "shipping_labels", "labor", "bonuses", "other"] as const;

const AddSchema = z.object({
  showId: z.uuid(),
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(1).max(200),
  amount: money,
  at: z.string().optional(),
});

/** A fixed expense lands in the minute it was incurred (clamped into the show by the engine). */
async function _addShowExpense(form: FormData) {
  const user = await requireWriter();
  const f = AddSchema.parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const incurred = f.at ? localToUtc(await getTimezone(sb), f.at).toISOString() : new Date().toISOString();
  const row = {
    show_id: f.showId,
    kind: f.category === "giveaways" ? "giveaway" : "one_time",
    category: f.category,
    description: f.description,
    amount: f.amount,
    incurred_at: incurred,
    created_by: user.id,
  };
  const { data, error } = await sb.from("show_expenses").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  await audit(user.id, "expense.add", "show_expenses", data.id, null, row);
  revalidatePath("/expenses");
}

async function _updateShowExpense(form: FormData) {
  const user = await requireWriter();
  const f = z
    .object({ id: z.uuid(), category: z.enum(CATEGORIES), description: z.string().trim().min(1).max(200), amount: money })
    .parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("show_expenses").select("*").eq("id", f.id).single();
  if (!before) throw new Error("Expense not found");
  const after = { category: f.category, kind: f.category === "giveaways" ? "giveaway" : "one_time", description: f.description, amount: f.amount };
  const { error } = await sb.from("show_expenses").update(after).eq("id", f.id);
  if (error) throw new Error(error.message);
  await audit(user.id, "expense.update", "show_expenses", f.id, before, after);
  revalidatePath("/expenses");
}

async function _deleteShowExpense(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("id"));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("show_expenses").select("*").eq("id", id).single();
  await sb.from("show_expenses").delete().eq("id", id);
  await audit(user.id, "expense.delete", "show_expenses", id, before);
  revalidatePath("/expenses");
}

export const addShowExpense = async (_p: ActionState, f: FormData) => run(_addShowExpense, f);
export const updateShowExpense = async (_p: ActionState, f: FormData) => run(_updateShowExpense, f);
export const deleteShowExpense = async (_p: ActionState, f: FormData) => run(_deleteShowExpense, f);
