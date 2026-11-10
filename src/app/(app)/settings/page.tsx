import Link from "next/link";
import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { PLATFORM_LABEL } from "@/lib/format";
import { EXPENSE_CATEGORIES, type HourlyExpenseRule } from "@/lib/engine/types";
import { ActionForm } from "@/components/ActionForm";
import { PageHeader } from "@/components/ui";
import { saveAlerts, saveCosts, saveRules } from "./actions";

const ALERT_LABEL: Record<string, [string, string]> = {
  no_sale_minutes: ["No sale for", "minutes"],
  profit_per_hour_below: ["Profit per hour below", "$"],
  margin_below_pct: ["Profit margin below", "%"],
  items_per_hour_below: ["Items per hour below", "items"],
  show_unprofitable: ["Show turns unprofitable", ""],
};

const n2 = (v: unknown) => (v === null || v === undefined ? "" : Number(v).toFixed(2));
const HOURLY_ROWS = 4;

export default async function SettingsPage() {
  const sb = await supabaseServer();
  const user = await currentUser();
  const canWrite = user?.canWrite ?? false;
  const [{ data: profiles }, { data: fees }, { data: alerts }, { data: settings }] = await Promise.all([
    sb.from("cost_profiles").select("*").eq("is_active", true),
    sb.from("fee_rules").select("*").eq("is_active", true),
    sb.from("alert_rules").select("*").order("kind"),
    sb.from("app_settings").select("*").eq("id", 1).single(),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        title="Settings"
        sub="Cost changes apply to shows started afterwards. Every show keeps the rules frozen when it started; you can override them per show on the show's page."
      >
        <Link href="/products" className="btn">SKU costs</Link>
        <Link href="/team" className="btn">Staff pay</Link>
      </PageHeader>

      <section>
        <h2 className="label mb-3">Default cost rules</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {(["tiktok", "whatnot", "manual"] as const).map((p) => {
            const c = profiles?.find((x) => x.platform === p);
            const f = fees?.find((x) => x.platform === p);
            const hourly: HourlyExpenseRule[] = Array.isArray(c?.hourly_expenses) ? (c!.hourly_expenses as HourlyExpenseRule[]) : [];
            return (
              <ActionForm key={p} action={saveCosts} className="card space-y-3 p-5" successText="Saved — applies to new shows.">
                <input type="hidden" name="platform" value={p} />
                <div className="font-semibold">{PLATFORM_LABEL[p]}</div>
                <Group title="Products">
                  <Field name="default_product_cost" label="Fallback cost / unit (no SKU cost)" value={n2(c?.default_product_cost)} prefix="$" />
                  <Field name="packing_per_item" label="Packing / unit" value={n2(c?.packing_per_item)} prefix="$" />
                </Group>
                <Group title="Presenter (default)">
                  <Field name="host_per_item" label="Per item sold (minimum)" value={n2(c?.host_per_item)} prefix="$" />
                  <Field
                    name="presenter_pct_of_avg_pct"
                    label="…or this % of the avg item price (whole dollars), if higher"
                    value={c ? (Number(c.presenter_pct_of_avg ?? 0.1) * 100).toFixed(2) : "10.00"}
                    suffix="%"
                  />
                  <Field name="host_per_hour" label="Per hour" value={n2(c?.host_per_hour)} prefix="$" />
                  <Field name="presenter_percent_pct" label="% of sales" value={c ? (Number(c.presenter_percent_of_sales ?? 0) * 100).toFixed(2) : "0"} suffix="%" />
                  <Field name="host_flat_per_show" label="Flat per show" value={n2(c?.host_flat_per_show)} prefix="$" />
                </Group>
                <Group title="Assistant (default)">
                  <Field name="assistant_per_hour" label="Per hour" value={n2(c?.assistant_per_hour)} prefix="$" />
                </Group>
                <Group title="Hourly expenses (prorated to LIVE time)">
                  {Array.from({ length: HOURLY_ROWS }, (_, i) => {
                    const h = hourly[i];
                    return (
                      <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-1.5">
                        <input name={`hourly_label_${i}`} defaultValue={h?.label ?? ""} placeholder={i === 0 ? "Giveaways / misc." : "Label"} className="input py-1.5 text-sm" aria-label="Expense label" />
                        <select name={`hourly_category_${i}`} defaultValue={h?.category ?? "other"} className="input w-auto py-1.5 text-xs" aria-label="Category">
                          {EXPENSE_CATEGORIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                        </select>
                        <span className="flex items-center gap-1"><span className="text-faint">$</span><input name={`hourly_rate_${i}`} defaultValue={h ? n2(h.perHour) : ""} placeholder="/h" inputMode="decimal" className="input num w-20 py-1.5 text-right" aria-label="Per hour" /></span>
                      </div>
                    );
                  })}
                  <p className="text-[11px] text-faint">Leave a row blank to remove it.</p>
                </Group>
                <Group title="Platform & shipping">
                  <Field name="percent_fee_pct" label="Commission (% of product revenue)" value={f ? (Number(f.percent_fee) * 100).toFixed(2) : ""} suffix="%" />
                  <Field name="fixed_fee_per_transaction" label="Fixed fee / order" value={n2(f?.fixed_fee_per_transaction)} prefix="$" />
                  <Field name="shipping_estimate" label="Shipping estimate / package (blank = pending until TikTok settles)" value={n2(c?.shipping_estimate_per_package)} prefix="$" optional />
                </Group>
                {canWrite && <button className="btn-primary w-full">Save {PLATFORM_LABEL[p]}</button>}
              </ActionForm>
            );
          })}
        </div>
      </section>

      <section className="card p-5">
        <h2 className="label mb-3">Reporting & LIVE attribution</h2>
        <ActionForm action={saveRules} className="grid gap-4 md:grid-cols-2" successText="Saved.">
          <L label="Reporting time zone">
            <select name="timezone" defaultValue={settings?.timezone ?? "America/New_York"} className="input">
              {["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Jerusalem", "UTC"].map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </L>
          <L label="Place revenue on the timeline by">
            <select name="revenue_basis" defaultValue={settings?.revenue_basis ?? "created"} className="input">
              <option value="created">Order creation time</option>
              <option value="paid">Payment time (when TikTok reports it)</option>
            </select>
          </L>
          <L label="Count orders this many minutes before a manual show starts">
            <input name="attribution_before_minutes" type="number" min={0} max={120} defaultValue={settings?.attribution_before_minutes ?? 0} className="input" />
          </L>
          <L label="…and this many minutes after it ends">
            <input name="attribution_after_minutes" type="number" min={0} max={240} defaultValue={settings?.attribution_after_minutes ?? 5} className="input" />
          </L>
          <L label="Close an auto-detected LIVE after this many quiet minutes">
            <input name="auto_show_idle_minutes" type="number" min={5} max={240} defaultValue={settings?.auto_show_idle_minutes ?? 20} className="input" />
          </L>
          <div className="text-xs text-faint md:self-end">
            TikTok&apos;s LIVE id on each order always wins. The time window is only a fallback when an order carries no LIVE information; orders that fit more
            than one show are flagged for review, never guessed.
          </div>
          {canWrite && <button className="btn-primary w-fit">Save</button>}
        </ActionForm>
        <p className="mt-2 text-xs text-faint">All times are stored in UTC and displayed in the reporting time zone.</p>
      </section>

      <section className="card p-5">
        <h2 className="label mb-3">Live alerts</h2>
        <p className="mb-3 text-sm text-muted">Shown on the live dashboard. Rate-based alerts wait for 15 minutes of show time to avoid false alarms.</p>
        <ActionForm action={saveAlerts} className="space-y-2" successText="Alerts saved.">
          {(alerts ?? []).map((a) => {
            const [label, unit] = ALERT_LABEL[a.kind] ?? [a.kind, ""];
            return (
              <div key={a.id} className="flex items-center gap-3 text-sm">
                <input type="checkbox" name={`enabled_${a.id}`} defaultChecked={a.enabled} className="h-4 w-4 accent-[#d9b26b]" />
                <span className="flex-1">{label}</span>
                {a.kind !== "show_unprofitable" ? (
                  <>
                    <input name={`threshold_${a.id}`} defaultValue={Number(a.threshold)} inputMode="decimal" className="input w-24 py-1" />
                    <span className="w-14 text-muted">{unit}</span>
                  </>
                ) : (
                  <input type="hidden" name={`threshold_${a.id}`} value="0" />
                )}
              </div>
            );
          })}
          {canWrite && <button className="btn-primary mt-2">Save alerts</button>}
        </ActionForm>
      </section>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-t border-line/60 pt-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{title}</div>
      {children}
    </div>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}

function Field({ name, label, value, prefix, suffix, optional }: { name: string; label: string; value: string; prefix?: string; suffix?: string; optional?: boolean }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-1">
        {prefix && <span className="text-faint">{prefix}</span>}
        <input name={name} defaultValue={value} inputMode="decimal" required={!optional} className="input num w-24 py-1.5 text-right" />
        {suffix && <span className="text-faint">{suffix}</span>}
      </span>
    </label>
  );
}
