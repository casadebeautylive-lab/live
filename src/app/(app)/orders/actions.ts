"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, requireWriter, supabaseAdmin } from "@/lib/supabase/clients";
import { run, type ActionState } from "@/lib/action-state";

/**
 * Manual show attribution. Orders are server-written (RLS), so writes use the
 * service client after the writer check. Every decision is logged to
 * order_show_attributions (decided_by) and audit_logs.
 */
async function decide(orderId: string, showId: string | null, status: "assigned" | "unassigned" | "not_live", note: string) {
  const user = await requireWriter();
  const sb = supabaseAdmin();
  const { data: before } = await sb.from("orders").select("id, show_id, attribution, attribution_method, attribution_note, is_test").eq("id", orderId).single();
  if (!before) throw new Error("Order not found");
  if (showId) {
    const { data: show } = await sb.from("live_shows").select("is_test").eq("id", showId).single();
    if (!show) throw new Error("Show not found");
    if (show.is_test !== before.is_test) throw new Error("Test orders can only go on test shows (and real orders on real shows)");
  }
  const after = { show_id: showId, attribution: status, attribution_method: status === "assigned" ? "manual" : null, attribution_note: note };
  const { error } = await sb.from("orders").update(after).eq("id", orderId);
  if (error) throw new Error(error.message);
  await sb.from("order_show_attributions").insert({ order_id: orderId, show_id: showId, status, method: "manual", note, decided_by: user.id });
  await audit(user.id, "order.attribution", "orders", orderId, before, after);
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  if (before.show_id) revalidatePath(`/shows/${before.show_id}`);
  if (showId) revalidatePath(`/shows/${showId}`);
}

async function _assignOrderToShow(form: FormData) {
  const f = z
    .object({ orderId: z.uuid(), showId: z.union([z.uuid(), z.literal("")]), note: z.string().trim().max(300).optional() })
    .parse(Object.fromEntries(form));
  if (f.showId) await decide(f.orderId, f.showId, "assigned", f.note || "Assigned manually");
  else await decide(f.orderId, null, "unassigned", f.note || "Unassigned manually");
}

async function _markNotLive(form: FormData) {
  const orderId = z.uuid().parse(form.get("orderId"));
  await decide(orderId, null, "not_live", "Marked as not a LIVE order");
}

export const assignOrderToShow = async (_p: ActionState, f: FormData) => run(_assignOrderToShow, f);
export const markNotLive = async (_p: ActionState, f: FormData) => run(_markNotLive, f);
