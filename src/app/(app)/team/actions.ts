"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, requireWriter, supabaseServer } from "@/lib/supabase/clients";
import { Decimal } from "@/lib/engine/money";
import { run, type ActionState } from "@/lib/action-state";

const money = z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "Enter an amount like 12.50");
/** Blank = use the show's default rate for that role. */
const optMoney = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null))
  .pipe(money.nullable());
/** Entered as a percentage ("5" = 5%), stored as a fraction (0.05). Blank = show default. */
const optPercent = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null))
  .pipe(
    z
      .string()
      .regex(/^\d+(\.\d{1,4})?$/, "Enter a percentage like 5 or 2.5")
      .refine((v) => new Decimal(v).lt(100), "must be below 100%")
      .nullable(),
  );

const StaffSchema = z.object({
  id: z.union([z.uuid(), z.literal("")]).optional(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["host", "assistant"]),
  perUnit: optMoney,
  perHour: optMoney,
  percentOfSales: optPercent,
  flatPerShow: optMoney,
});

/**
 * Columns match how staffComp() (lib/data/costs.ts) reads a staff profile:
 * hosts use host_per_item / host_per_hour / host_flat_per_show / percent_of_sales,
 * assistants use hourly_rate / percent_of_sales. Rates are frozen onto a shift
 * when the person is assigned, so edits only affect future shifts.
 */
function toRow(s: z.infer<typeof StaffSchema>) {
  const pct = s.percentOfSales === null ? null : new Decimal(s.percentOfSales).div(100).toFixed(6);
  const host = s.role === "host";
  return {
    name: s.name,
    role: s.role,
    host_per_item: host ? s.perUnit : null,
    host_per_hour: host ? s.perHour : null,
    host_flat_per_show: host ? s.flatPerShow : null,
    hourly_rate: host ? null : s.perHour,
    percent_of_sales: pct,
  };
}

async function _saveStaff(form: FormData) {
  const user = await requireWriter();
  const s = StaffSchema.parse(Object.fromEntries(form));
  const row = toRow(s);
  const sb = await supabaseServer();
  if (s.id) {
    const { data: before } = await sb.from("staff").select("*").eq("id", s.id).single();
    if (!before) throw new Error("Staff member not found");
    const { data: after, error } = await sb.from("staff").update(row).eq("id", s.id).select("*").single();
    if (error) throw new Error(error.message);
    await audit(user.id, "staff.update", "staff", s.id, before, after);
  } else {
    const { data, error } = await sb.from("staff").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    await audit(user.id, "staff.add", "staff", data.id, null, data);
  }
  revalidatePath("/team");
  revalidatePath("/settings");
}

async function _deactivateStaff(form: FormData) {
  const user = await requireWriter();
  const { id, reactivate } = z.object({ id: z.uuid(), reactivate: z.literal("1").optional() }).parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("staff").select("*").eq("id", id).single();
  if (!before) throw new Error("Staff member not found");
  const active = reactivate === "1";
  const { data: after, error } = await sb.from("staff").update({ active }).eq("id", id).select("*").single();
  if (error) throw new Error(error.message);
  await audit(user.id, active ? "staff.reactivate" : "staff.deactivate", "staff", id, before, after);
  revalidatePath("/team");
  revalidatePath("/settings");
}

export async function saveStaff(_prev: ActionState, form: FormData) {
  return run(_saveStaff, form);
}
export async function deactivateStaff(_prev: ActionState, form: FormData) {
  return run(_deactivateStaff, form);
}
