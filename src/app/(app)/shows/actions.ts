"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit, currentUser, requireWriter, supabaseAdmin, supabaseServer } from "@/lib/supabase/clients";
import { buildCostSnapshot, staffComp } from "@/lib/data/costs";
import { ingestOrder } from "@/lib/ingest/ingest";
import { SupabaseIngestRepo } from "@/lib/ingest/supabase-repo";
import { endedStatus, freezeOriginalEstimate } from "@/lib/lifecycle";
import { normalizeCosts } from "@/lib/engine/defaults";
import type { CostSnapshot, ExpenseCategory, HourlyExpenseRule } from "@/lib/engine/types";
import { onShowEnded } from "@/lib/creators/scan";
import { run, type ActionState } from "@/lib/action-state";
import { localToUtc } from "@/lib/dates";
import { parseScanCsv, unitCostsByUpc, type ScanReport } from "@/lib/scan-report";
import { parseScanPdf } from "@/lib/scan-report-pdf";
import { getTimezone } from "@/lib/data/context";

const money = z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "Enter an amount like 12.50");
const optMoney = z.union([money, z.literal("")]).optional();
const uuidOrEmpty = z.union([z.uuid(), z.literal("")]).optional();
const isoLocal = z.string().trim().min(1); // from <input type="datetime-local">, converted with the browser offset
const CATEGORIES = ["giveaways", "advertising", "packaging", "shipping_labels", "labor", "bonuses", "other"] as const;

/** Form times are wall-clock in the account time zone (what every page displays). */
async function toIso(local: string): Promise<string> {
  const sb = await supabaseServer();
  return localToUtc(await getTimezone(sb), local).toISOString();
}

async function staffRow(sb: Awaited<ReturnType<typeof supabaseServer>>, snapshot: CostSnapshot, showId: string, role: "host" | "assistant", staffId: string | null, joinedAt: string) {
  let person: any = null;
  if (staffId) {
    const { data } = await sb.from("staff").select("*").eq("id", staffId).maybeSingle();
    person = data;
  }
  return {
    show_id: showId,
    staff_id: staffId,
    role,
    name: person?.name ?? (role === "host" ? "Presenter" : "Assistant"),
    joined_at: joinedAt,
    comp: staffComp(snapshot, role, person),
  };
}

// ---------------------------------------------------------------------------
// Start / schedule
// ---------------------------------------------------------------------------
const StartSchema = z.object({
  title: z.string().trim().min(1).max(120),
  platform: z.enum(["tiktok", "whatnot", "manual"]),
  hostId: uuidOrEmpty,
  assistantId: z.union([z.uuid(), z.literal(""), z.literal("none")]).optional(),
  giveawaysPerHour: optMoney,
  isTest: z.literal("on").optional(),
  scheduledStart: z.string().optional(),
  scheduledEnd: z.string().optional(),
});

function applyHourlyOverride(snapshot: CostSnapshot, perHour: string | undefined) {
  if (!perHour) return;
  const rules: HourlyExpenseRule[] = normalizeCosts(snapshot).hourlyExpenses;
  if (rules.length) rules[0] = { ...rules[0], perHour };
  else rules.push({ category: "giveaways", label: "Giveaways / misc.", perHour });
  snapshot.hourlyExpenses = rules;
  snapshot.version = 2;
}

async function _startShow(form: FormData) {
  const user = await requireWriter();
  const input = StartSchema.parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { snapshot, costProfileId, feeRuleId } = await buildCostSnapshot(sb, input.platform);
  applyHourlyOverride(snapshot, input.giveawaysPerHour);
  const scheduled = !!input.scheduledStart;
  const startedAt = scheduled ? await toIso(input.scheduledStart!) : new Date().toISOString();

  const { data: show, error } = await sb
    .from("live_shows")
    .insert({
      title: input.title,
      platform: input.platform,
      is_test: input.isTest === "on",
      status: scheduled ? "scheduled" : "live",
      started_at: startedAt,
      scheduled_start: scheduled ? startedAt : null,
      scheduled_end: scheduled && input.scheduledEnd ? await toIso(input.scheduledEnd) : null,
      cost_snapshot: snapshot,
      cost_profile_id: costProfileId,
      fee_rule_id: feeRuleId,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("A show is already running on this platform. End it first.");
    throw new Error(error.message);
  }
  const rows = [await staffRow(sb, snapshot, show.id, "host", input.hostId || null, startedAt)];
  if (input.assistantId !== "none") rows.push(await staffRow(sb, snapshot, show.id, "assistant", input.assistantId || null, startedAt));
  const { error: se } = await sb.from("show_staff").insert(rows);
  if (se) throw new Error(se.message);
  if (!scheduled) await supabaseAdmin().rpc("assign_orders_to_show", { p_show: show.id });
  await audit(user.id, scheduled ? "show.schedule" : "show.start", "live_shows", show.id, null, { ...input, snapshot });
  redirect(scheduled ? "/shows" : `/live?show=${show.id}`);
}

/** A scheduled show goes live now: the clock starts at this moment. */
async function _goLive(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("showId"));
  const sb = await supabaseServer();
  const now = new Date().toISOString();
  const { error } = await sb.from("live_shows").update({ status: "live", started_at: now }).eq("id", id).eq("status", "scheduled");
  if (error) {
    if (error.code === "23505") throw new Error("Another show is already running on this platform. End it first.");
    throw new Error(error.message);
  }
  await sb.from("show_staff").update({ joined_at: now }).eq("show_id", id);
  await supabaseAdmin().rpc("assign_orders_to_show", { p_show: id });
  await audit(user.id, "show.go_live", "live_shows", id);
  redirect(`/live?show=${id}`);
}

async function _pauseShow(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("showId"));
  const sb = await supabaseServer();
  await sb.from("show_pauses").insert({ show_id: id });
  await sb.from("live_shows").update({ status: "paused" }).eq("id", id).eq("status", "live");
  await audit(user.id, "show.pause", "live_shows", id);
  revalidatePath("/shows");
}

async function _resumeShow(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("showId"));
  const sb = await supabaseServer();
  await sb.from("show_pauses").update({ resumed_at: new Date().toISOString() }).eq("show_id", id).is("resumed_at", null);
  await sb.from("live_shows").update({ status: "live" }).eq("id", id).eq("status", "paused");
  await audit(user.id, "show.resume", "live_shows", id);
  revalidatePath("/shows");
}

async function _endShow(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("showId"));
  const sb = await supabaseServer();
  const now = new Date().toISOString();
  const { data: show } = await sb.from("live_shows").select("is_test, detection, last_activity_at, started_at").eq("id", id).single();
  // An auto-detected LIVE has no real "end" signal: end it at its last order (TikTok confirms the
  // real end later). Ending it at "now" hours later would charge hours of hourly costs.
  const endAt =
    show?.detection === "platform" && show.last_activity_at && Date.parse(show.last_activity_at) < Date.now() - 20 * 60_000
      ? show.last_activity_at
      : now;
  await sb.from("show_pauses").update({ resumed_at: endAt }).eq("show_id", id).is("resumed_at", null);
  await sb.from("live_shows").update({ status: endedStatus(!!show?.is_test), ended_at: endAt }).in("status", ["live", "paused"]).eq("id", id);
  const admin = supabaseAdmin();
  await admin.rpc("assign_orders_to_show", { p_show: id });
  await freezeOriginalEstimate(admin, id);
  await onShowEnded(admin, id);
  await audit(user.id, "show.end", "live_shows", id);
  revalidatePath("/shows");
  redirect(`/shows/${id}`);
}

/** Correct a show's title or times (e.g. it was started late). Audited. */
async function _editShow(form: FormData) {
  const user = await requireWriter();
  const f = z
    .object({ showId: z.uuid(), title: z.string().trim().min(1).max(120), startedAt: isoLocal, endedAt: z.string().optional(), notes: z.string().max(2000).optional() })
    .parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("live_shows").select("title, started_at, ended_at, status, notes").eq("id", f.showId).single();
  const startedAt = await toIso(f.startedAt);
  const endedAt = f.endedAt ? await toIso(f.endedAt) : before?.ended_at ?? null;
  if (endedAt && Date.parse(endedAt) < Date.parse(startedAt)) throw new Error("End must be after start");
  const after = { title: f.title, started_at: startedAt, ended_at: endedAt, notes: f.notes ?? before?.notes ?? null };
  const { error } = await sb.from("live_shows").update(after).eq("id", f.showId);
  if (error) throw new Error(error.message);
  await supabaseAdmin().rpc("assign_orders_to_show", { p_show: f.showId });
  await audit(user.id, "show.edit", "live_shows", f.showId, before, after);
  revalidatePath(`/shows/${f.showId}`);
}

// ---------------------------------------------------------------------------
// Staff shifts
// ---------------------------------------------------------------------------
async function _addShift(form: FormData) {
  const user = await requireWriter();
  const f = z.object({ showId: z.uuid(), role: z.enum(["host", "assistant"]), staffId: uuidOrEmpty }).parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { data: show } = await sb.from("live_shows").select("cost_snapshot, status, started_at, ended_at").eq("id", f.showId).single();
  if (!show) throw new Error("Show not found");
  const now = new Date().toISOString();
  const at = show.ended_at ? show.started_at : Date.parse(now) < Date.parse(show.started_at) ? show.started_at : now;
  // A show with no shifts pays the default presenter + assistant for the whole show.
  // Make those explicit first, so adding one person doesn't silently drop them.
  const { count } = await sb.from("show_staff").select("id", { count: "exact", head: true }).eq("show_id", f.showId);
  if ((count ?? 0) === 0) {
    const snap = show.cost_snapshot as CostSnapshot;
    await sb.from("show_staff").insert([
      await staffRow(sb, snap, f.showId, "host", null, show.started_at),
      await staffRow(sb, snap, f.showId, "assistant", null, show.started_at),
    ]);
  }
  const row = await staffRow(sb, show.cost_snapshot as CostSnapshot, f.showId, f.role, f.staffId || null, at);
  const { data, error } = await sb.from("show_staff").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  await audit(user.id, "shift.add", "show_staff", data.id, null, row);
  revalidatePath("/shows");
}

/** End a shift now (someone left mid-show). */
async function _endShift(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("shiftId"));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("show_staff").select("*").eq("id", id).single();
  const now = new Date().toISOString();
  await sb.from("show_staff").update({ left_at: now }).eq("id", id).is("left_at", null);
  await audit(user.id, "shift.end", "show_staff", id, before, { left_at: now });
  revalidatePath("/shows");
}

/** Edit a shift's times or pay (admins only — payroll). */
async function _editShift(form: FormData) {
  const user = await requireWriter();
  const f = z
    .object({
      shiftId: z.uuid(),
      joinedAt: z.string().optional(),
      leftAt: z.string().optional(),
          perUnit: money,
      perHour: money,
      percentOfSales: z.coerce.number().min(0).max(99),
      pctOfAvg: z.coerce.number().min(0).max(99).optional(),
      flatPerShow: money,
    })
    .parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("show_staff").select("*").eq("id", f.shiftId).single();
  if (!before) throw new Error("Shift not found");
  const after = {
    joined_at: f.joinedAt ? await toIso(f.joinedAt) : before.joined_at,
    left_at: f.leftAt ? await toIso(f.leftAt) : null,
    comp: {
      perUnit: f.perUnit,
      perHour: f.perHour,
      percentOfSales: (f.percentOfSales / 100).toFixed(6),
      flatPerShow: f.flatPerShow,
      pctOfAvgPrice: ((f.pctOfAvg ?? 0) / 100).toFixed(6),
    },
  };
  if (after.left_at && after.joined_at && Date.parse(after.left_at) < Date.parse(after.joined_at)) throw new Error("Shift end must be after its start");
  const { error } = await sb.from("show_staff").update(after).eq("id", f.shiftId);
  if (error) throw new Error(error.message);
  await audit(user.id, "shift.edit", "show_staff", f.shiftId, before, after);
  revalidatePath(`/shows/${before.show_id}`);
}

async function _removeShift(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("shiftId"));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("show_staff").select("*").eq("id", id).single();
  await sb.from("show_staff").delete().eq("id", id);
  await audit(user.id, "shift.remove", "show_staff", id, before);
  revalidatePath("/shows");
}

// ---------------------------------------------------------------------------
// Per-show cost overrides (written into the show's snapshot; audited)
// ---------------------------------------------------------------------------
async function _updateShowCosts(form: FormData) {
  const user = await requireWriter();
  const raw = Object.fromEntries(form);
  const f = z
    .object({ showId: z.uuid(), defaultProductCost: money, percentFeePct: z.coerce.number().min(0).max(99), packingPerItem: money, shippingEstimate: optMoney })
    .parse(raw);
  const sb = await supabaseServer();
  const { data: show } = await sb.from("live_shows").select("cost_snapshot").eq("id", f.showId).single();
  const current = show?.cost_snapshot as CostSnapshot;
  const n = normalizeCosts(current);
  const hourly = n.hourlyExpenses.map((h, i) => {
    const v = String(raw[`hourly_${i}`] ?? h.perHour).trim();
    return { ...h, perHour: money.parse(v) };
  });
  const next: CostSnapshot = {
    ...current,
    version: 2,
    presenter: n.presenter,
    assistant: n.assistant,
    hourlyExpenses: hourly,
    defaultProductCost: f.defaultProductCost,
    percentFee: (f.percentFeePct / 100).toFixed(6),
    packingPerItem: f.packingPerItem,
    shippingEstimatePerPackage: f.shippingEstimate ? f.shippingEstimate : null,
  };
  delete next.host;
  delete next.assistantPerHour;
  delete next.marketingPerHour;
  await sb.from("live_shows").update({ cost_snapshot: next }).eq("id", f.showId);
  await audit(user.id, "show.costs", "live_shows", f.showId, current, next);
  revalidatePath(`/shows/${f.showId}`);
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
const ExpenseSchema = z.object({
  showId: z.uuid(),
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(1).max(200),
  amount: money,
});

async function _addExpense(form: FormData) {
  const user = await requireWriter();
  const e = ExpenseSchema.parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { data: show } = await sb.from("live_shows").select("started_at, ended_at").eq("id", e.showId).single();
  // a fixed expense lands in the current minute while live, or the last minute of an ended show
  const now = Date.now();
  const at = show?.ended_at && Date.parse(show.ended_at) < now ? show.ended_at : new Date(Math.max(now, Date.parse(show?.started_at ?? new Date(now).toISOString()))).toISOString();
  const row = {
    show_id: e.showId,
    kind: e.category === "giveaways" ? "giveaway" : "one_time",
    category: e.category as ExpenseCategory,
    description: e.description,
    amount: e.amount,
    incurred_at: at,
    created_by: user.id,
  };
  const { data, error } = await sb.from("show_expenses").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  await audit(user.id, "expense.add", "show_expenses", data?.id ?? null, null, row);
  revalidatePath("/shows");
}

async function _deleteExpense(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("expenseId"));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("show_expenses").select("*").eq("id", id).single();
  await sb.from("show_expenses").delete().eq("id", id);
  await audit(user.id, "expense.delete", "show_expenses", id, before);
  revalidatePath("/shows");
}

/** Owner-only: re-snapshot a past show with today's cost settings (shifts keep their own rates). */
async function _recalculateShow(form: FormData) {
  const user = await currentUser();
  if (user?.role !== "owner") throw new Error("Only the owner can recalculate history");
  const id = z.uuid().parse(form.get("showId"));
  const sb = await supabaseServer();
  const { data: show } = await sb.from("live_shows").select("platform, cost_snapshot").eq("id", id).single();
  const { snapshot } = await buildCostSnapshot(sb, show!.platform);
  // an uploaded scan report is the show's real product cost — keep it through a recalculation
  const prevReport = (show?.cost_snapshot as CostSnapshot | null)?.scanReport;
  if (prevReport) snapshot.scanReport = prevReport;
  await sb.from("live_shows").update({ cost_snapshot: snapshot, recalculated_at: new Date().toISOString() }).eq("id", id);
  await audit(user.id, "show.recalculate", "live_shows", id, show?.cost_snapshot, snapshot);
  revalidatePath(`/shows/${id}`);
}

// ---------------------------------------------------------------------------
// Simulated sales — test shows only, flagged is_test, run through the real pipeline
// ---------------------------------------------------------------------------
const CATALOG = [
  { sku: "HOOP-GP-30", title: "Gold-plated hoop earrings 30mm", price: 12 },
  { sku: "CUBAN-GP-5", title: "Cuban link chain 5mm", price: 18 },
  { sku: "TENNIS-BR", title: "CZ tennis bracelet", price: 15 },
  { sku: "PEARL-STUD", title: "Freshwater pearl studs", price: 9 },
  { sku: "NAME-NECK", title: "Script name necklace", price: 22 },
  { sku: "STACK-RING", title: "Stacking ring set", price: 10 },
];
const TEST_BUYERS = ["TEST-BUYER-1", "TEST-BUYER-2", "TEST-BUYER-3", "TEST-BUYER-4", "TEST-BUYER-5"];

async function _simulateSales(form: FormData) {
  const user = await requireWriter();
  const { showId, count } = z.object({ showId: z.uuid(), count: z.coerce.number().int().min(1).max(50) }).parse(Object.fromEntries(form));
  const admin = supabaseAdmin();
  const { data: show } = await admin.from("live_shows").select("platform, is_test, status").eq("id", showId).single();
  if (!show?.is_test) throw new Error("Simulated sales are only allowed on test shows");
  if (!["live", "paused"].includes(show.status)) throw new Error("Show is not running");

  const repo = new SupabaseIngestRepo(admin);
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const p = CATALOG[Math.floor(Math.random() * CATALOG.length)];
    const qty = Math.random() < 0.15 ? 2 + Math.floor(Math.random() * 2) : 1;
    const id = `SIM-${now}-${i}-${Math.random().toString(36).slice(2, 7)}`;
    const buyer = TEST_BUYERS[Math.floor(Math.random() * TEST_BUYERS.length)];
    const r = await ingestOrder(repo, {
      platform: show.platform,
      externalOrderId: id,
      createdAt: new Date(now - (count - i) * 1000).toISOString(),
      status: "active",
      platformStatus: "SIMULATED",
      isTest: true,
      source: "test",
      customerId: buyer,
      customerName: `Test buyer ${buyer.slice(-1)}`,
      items: [{ externalItemId: `${id}-1`, sku: p.sku, title: p.title, quantity: qty, unitPrice: p.price.toFixed(2) }],
      customerShipping: "4.99",
      raw: { simulated: true },
    });
    if (!r.ok) throw new Error(r.error);
  }
  await audit(user.id, "test.simulate", "live_shows", showId, null, { count });
  revalidatePath("/shows");
}

/** Simulate a refund or cancellation of the latest test order (exercises the update path). */
async function _simulateAdjustment(form: FormData) {
  await requireWriter();
  const { showId, kind } = z.object({ showId: z.uuid(), kind: z.enum(["refund", "cancel"]) }).parse(Object.fromEntries(form));
  const admin = supabaseAdmin();
  const { data: o } = await admin
    .from("orders")
    .select("*, order_items(*)")
    .eq("show_id", showId)
    .eq("is_test", true)
    .eq("status", "active")
    .order("created_at_platform", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!o) throw new Error("No active test order to adjust");
  const item = o.order_items[0];
  await ingestOrder(new SupabaseIngestRepo(admin), {
    platform: o.platform,
    externalOrderId: o.external_order_id,
    createdAt: o.created_at_platform,
    status: kind === "cancel" ? "cancelled" : "active",
    platformStatus: kind === "cancel" ? "CANCELLED" : "SIMULATED",
    isTest: true,
    source: "test",
    items: o.order_items.map((i: any) => ({ externalItemId: i.external_item_id, sku: i.sku, title: i.title, quantity: i.quantity, unitPrice: String(i.unit_price) })),
    refunds:
      kind === "refund"
        ? [{ externalRefundId: `R-${o.external_order_id}`, externalItemId: item.external_item_id, quantity: 1, amount: String(item.unit_price), refundedAt: new Date().toISOString() }]
        : [],
    customerShipping: String(o.customer_shipping),
  });
  revalidatePath("/shows");
}

// Exported actions (useActionState signature)
export const startShow = async (_p: ActionState, f: FormData) => run(_startShow, f);
export const goLive = async (_p: ActionState, f: FormData) => run(_goLive, f);
export const pauseShow = async (_p: ActionState, f: FormData) => run(_pauseShow, f);
export const resumeShow = async (_p: ActionState, f: FormData) => run(_resumeShow, f);
export const endShow = async (_p: ActionState, f: FormData) => run(_endShow, f);
export const editShow = async (_p: ActionState, f: FormData) => run(_editShow, f);
export const addShift = async (_p: ActionState, f: FormData) => run(_addShift, f);
export const endShift = async (_p: ActionState, f: FormData) => run(_endShift, f);
export const editShift = async (_p: ActionState, f: FormData) => run(_editShift, f);
export const removeShift = async (_p: ActionState, f: FormData) => run(_removeShift, f);
// ---------------------------------------------------------------------------
// End-of-show scan report (real product cost)
// ---------------------------------------------------------------------------
async function _uploadScanReport(form: FormData) {
  const user = await requireWriter();
  const showId = z.uuid().parse(form.get("showId"));
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose the End of Show Scan Report (PDF or CSV).");
  if (file.size > 20 * 1024 * 1024) throw new Error("File is too large (max 20 MB).");
  let report: ScanReport;
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") report = await parseScanPdf(new Uint8Array(await file.arrayBuffer()));
  else if (/\.csv$/i.test(file.name)) report = parseScanCsv(await file.text());
  else throw new Error("Upload the scan report as a PDF or CSV.");
  if (report.units <= 0) throw new Error("The report has no scanned units.");

  const sb = supabaseAdmin();
  const { data: show } = await sb.from("live_shows").select("cost_snapshot").eq("id", showId).single();
  if (!show) throw new Error("Show not found.");
  const current = show.cost_snapshot as CostSnapshot;
  const next: CostSnapshot = { ...current, scanReport: { totalCogs: report.totalCogs, units: report.units, unitCosts: unitCostsByUpc(report.lines) } };
  const { error } = await sb.from("show_scan_reports").upsert(
    {
      show_id: showId,
      file_name: file.name.slice(0, 200),
      report_date: report.reportDate,
      show_label: report.showLabel,
      units: report.units,
      total_cogs: report.totalCogs,
      lines: report.lines,
      warnings: report.warnings,
      uploaded_by: user.id,
      uploaded_at: new Date().toISOString(),
    },
    { onConflict: "show_id" },
  );
  if (error) throw new Error(error.message);
  await sb.from("live_shows").update({ cost_snapshot: next }).eq("id", showId);
  await audit(user.id, "show.scan_report", "live_shows", showId, { scanReport: current.scanReport ?? null }, { file: file.name, units: report.units, totalCogs: report.totalCogs });
  revalidatePath(`/shows/${showId}`);
  revalidatePath("/history");
}

async function _removeScanReport(form: FormData) {
  const user = await requireWriter();
  const showId = z.uuid().parse(form.get("showId"));
  const sb = supabaseAdmin();
  const { data: show } = await sb.from("live_shows").select("cost_snapshot").eq("id", showId).single();
  const current = show?.cost_snapshot as CostSnapshot;
  const next: CostSnapshot = { ...current };
  delete next.scanReport;
  await sb.from("show_scan_reports").delete().eq("show_id", showId);
  await sb.from("live_shows").update({ cost_snapshot: next }).eq("id", showId);
  await audit(user.id, "show.scan_report_removed", "live_shows", showId, { scanReport: current?.scanReport ?? null }, null);
  revalidatePath(`/shows/${showId}`);
  revalidatePath("/history");
}

export const uploadScanReport = async (_p: ActionState, f: FormData) => run(_uploadScanReport, f);
export const removeScanReport = async (_p: ActionState, f: FormData) => run(_removeScanReport, f);
export const updateShowCosts = async (_p: ActionState, f: FormData) => run(_updateShowCosts, f);
export const addExpense = async (_p: ActionState, f: FormData) => run(_addExpense, f);
export const deleteExpense = async (_p: ActionState, f: FormData) => run(_deleteExpense, f);
export const recalculateShow = async (_p: ActionState, f: FormData) => run(_recalculateShow, f);
export const simulateSales = async (_p: ActionState, f: FormData) => run(_simulateSales, f);
export const simulateAdjustment = async (_p: ActionState, f: FormData) => run(_simulateAdjustment, f);
