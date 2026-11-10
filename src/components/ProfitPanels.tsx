/**
 * Expense, revenue/fees and data-quality panels. Plain (server-safe) components:
 * the show page renders them on the server with real Decimal values, and the live
 * dashboard (a client component) imports them too. They must stay free of hooks —
 * passing Decimals into a "use client" component from a server page turns them into
 * strings and crashes the page.
 */
import { formatUsd, type Decimal } from "@/lib/engine/money";
import type { ProfitMetrics } from "@/lib/engine/profit";

function Row({ label, value, tone = "", sub }: { label: string; value: string; tone?: string; sub?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 py-1.5 text-sm ${sub ? "pl-3 text-muted" : ""}`}>
      <span>{label}</span>
      <span className={`num whitespace-nowrap ${tone}`}>{value}</span>
    </div>
  );
}

export function CostBreakdown({ profit }: { profit: ProfitMetrics }) {
  const c = profit.costs;
  const lines: [string, Decimal][] = [
    ["Product cost", c.product],
    ...profit.labor.byStaff.map((s) => {
      const role = s.role === "host" ? "presenter" : "assistant";
      return [s.name.toLowerCase() === role ? s.name : `${s.name} (${role})`, s.total] as [string, Decimal];
    }),
    ...profit.hourlyExpenseBreakdown.map((h) => [`${h.label} (hourly)`, h.amount] as [string, Decimal]),
    ...profit.fixedExpenseBreakdown.map((f) => [f.category.replace("_", " ").replace(/^./, (x) => x.toUpperCase()), f.amount] as [string, Decimal]),
    ["Packing", c.packing],
    ["Platform fees (est.)", c.percentFee.plus(c.fixedFee)],
    ["Platform fees (TikTok-reported)", c.actualPlatformFees],
    ["Net shipping", profit.netShippingCost],
  ];
  const total = profit.totalExpenses.toNumber() || 1;
  return (
    <div className="card p-5">
      <div className="label mb-3 flex justify-between">
        <span>Expenses</span>
        <span className="num text-ink">{formatUsd(profit.totalExpenses)}</span>
      </div>
      <div className="space-y-2">
        {lines
          .filter(([, v]) => !v.isZero())
          .map(([name, v], i) => (
            <div key={name + i}>
              <div className="flex justify-between gap-3 text-sm">
                <span className="truncate text-muted">{name}</span>
                <span className={`num ${v.isNegative() ? "text-pos" : ""}`}>{formatUsd(v)}</span>
              </div>
              <div className="mt-1 h-1 rounded bg-line">
                <div className="h-1 rounded bg-gold-dim" style={{ width: `${Math.max(0, Math.min(100, (v.toNumber() / total) * 100))}%` }} />
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

export function ShippingAndFees({ profit }: { profit: ProfitMetrics }) {
  return (
    <div className="card p-5">
      <div className="label mb-2">Revenue, fees & shipping</div>
      <Row label="Gross product sales" value={formatUsd(profit.grossMerchandise)} />
      <Row label="− Seller-funded discounts" value={formatUsd(profit.sellerDiscounts)} sub />
      <Row label="− Refunds" value={formatUsd(profit.refunds)} sub />
      <Row label="Product revenue" value={formatUsd(profit.netMerchandise)} tone="font-semibold" />
      <Row label="Platform-funded discounts (paid by TikTok)" value={formatUsd(profit.platformDiscounts)} sub />
      <div className="my-2 border-t border-line" />
      <Row label="Platform fees" value={formatUsd(profit.platformFees)} />
      <Row label={profit.flags.feesEstimated ? "  of which estimated (6% rule)" : "  all reported by TikTok"} value={formatUsd(profit.costs.percentFee.plus(profit.costs.fixedFee))} sub />
      <div className="my-2 border-t border-line" />
      <Row label="Customer paid shipping (not revenue)" value={formatUsd(profit.customerShipping)} />
      <Row label="+ Platform shipping subsidy" value={formatUsd(profit.platformShippingSubsidy)} sub />
      <Row label="− Seller shipping charges" value={formatUsd(profit.sellerShippingCost)} sub />
      <Row label="Net shipping cost" value={formatUsd(profit.netShippingCost)} tone={profit.netShippingCost.isNegative() ? "text-pos" : ""} />
      {profit.flags.shippingUnknownOrders > 0 && <Row label={`  ${profit.flags.shippingUnknownOrders} orders pending`} value="Pending" sub />}
      <div className="my-2 border-t border-line" />
      <Row label="Platform GMV (reported)" value={profit.platformGmv ? formatUsd(profit.platformGmv) : "Not reported"} />
      <Row label="Estimated payout" value={formatUsd(profit.estimatedPayout)} />
      <Row label="Confirmed settlement" value={profit.confirmedSettlement ? `${formatUsd(profit.confirmedSettlement)} (${profit.settledOrders}/${profit.orders})` : "Pending"} />
    </div>
  );
}

export function Flags({ profit, outOfOrder = 0 }: { profit: ProfitMetrics; outOfOrder?: number }) {
  const f = profit.flags;
  if (!(f.productCostEstimated || f.feesEstimated || f.shippingEstimated || outOfOrder > 0 || f.outsideWindowOrders > 0)) return null;
  return (
    <section className="mt-4 space-y-1 text-xs text-muted">
      {f.productCostEstimated && (
        <p>
          Product cost uses the default for {f.estimatedSkus.length} SKU(s) without a set cost: {f.estimatedSkus.slice(0, 8).join(", ")}
          {f.estimatedSkus.length > 8 ? "…" : ""}.
        </p>
      )}
      {f.feesEstimated && <p>Platform fees are estimated from your fee rule until TikTok reports the actual fees.</p>}
      {f.shippingEstimated && <p>Seller shipping is estimated or pending for some orders — final figures arrive with TikTok settlement.</p>}
      {f.outsideWindowOrders > 0 && <p>{f.outsideWindowOrders} order(s) belong to this show but were timestamped outside its window; they are counted in the first/last minute.</p>}
      {outOfOrder > 0 && <p>{outOfOrder} order event(s) arrived out of order; metrics use TikTok&apos;s timestamps.</p>}
    </section>
  );
}

/** What buyers paid, split into product money and shipping money. */
export function MoneyIn({ profit }: { profit: ProfitMetrics }) {
  const collected = profit.netMerchandise.plus(profit.customerShipping);
  const perOrder = (v: Decimal) => (profit.orders ? formatUsd(v.div(profit.orders)) : "—");
  return (
    <section className="card p-4 sm:p-5">
      <div className="label mb-3">Money in from buyers</div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <div>
          <div className="text-xs text-muted">From products</div>
          <div className="num mt-1 text-xl font-semibold sm:text-2xl">{formatUsd(profit.netMerchandise)}</div>
          <div className="num text-xs text-faint">{perOrder(profit.netMerchandise)} / order</div>
        </div>
        <div>
          <div className="text-xs text-muted">From shipping</div>
          <div className="num mt-1 text-xl font-semibold sm:text-2xl">{formatUsd(profit.customerShipping)}</div>
          <div className="num text-xs text-faint">{perOrder(profit.customerShipping)} / order</div>
        </div>
        <div>
          <div className="text-xs text-muted">Total buyers paid</div>
          <div className="num mt-1 text-xl font-semibold text-gold sm:text-2xl">{formatUsd(collected)}</div>
          <div className="num text-xs text-faint">{perOrder(collected)} / order · before tax</div>
        </div>
        <div>
          <div className="text-xs text-muted">Refunded</div>
          <div className={`num mt-1 text-xl font-semibold sm:text-2xl ${profit.refunds.gt(0) ? "text-warn" : ""}`}>{formatUsd(profit.refunds)}</div>
          <div className="num text-xs text-faint">{profit.refundedOrders} order(s)</div>
        </div>
        <div>
          <div className="text-xs text-muted">Shipping cost to you</div>
          <div className="num mt-1 text-xl font-semibold sm:text-2xl">
            {profit.flags.shippingUnknownOrders === profit.orders && profit.orders ? "Pending" : formatUsd(profit.netShippingCost)}
          </div>
          <div className="text-xs text-faint">after what buyers paid · final when TikTok settles</div>
        </div>
      </div>
      <p className="mt-3 text-xs text-faint">
        Profit counts product money only. Shipping buyers pay goes toward the labels, it isn&apos;t profit. Sales tax is collected and paid by TikTok, so it isn&apos;t included.
      </p>
    </section>
  );
}
