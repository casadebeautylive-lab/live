/**
 * Domain types for the profit engine.
 *
 * All money values are decimal strings (e.g. "12.50") so they survive JSON and
 * Postgres numeric round-trips without floating-point loss. The engine converts
 * them to Decimal internally.
 */

export type Platform = "tiktok" | "whatnot" | "manual";

/** Legacy (v1) host compensation shape, still read from older show snapshots. */
export type HostCompensation = {
  perItem: string; // $ per unit sold
  perHour: string; // $ per active show hour
  flatPerShow: string; // $ once per show
};

/**
 * How one person is paid for a show. Any combination may be non-zero:
 * per unit sold, per active hour on shift, a percentage of product sales
 * made while on shift, and a flat amount per show.
 */
export type CompRates = {
  perUnit: string;
  perHour: string;
  /** Fraction of product sales (after seller discounts), e.g. "0.05" for 5%. */
  percentOfSales: string;
  flatPerShow: string;
  /**
   * Tiered per-unit commission: each sold item pays max(perUnit, pctOfAvgPrice × the show's
   * average item price rounded down to whole dollars). "0.10" → $1/item up to an $11 average,
   * $1.20 for $12.00–$12.99, $1.50 for $15.00–$15.99.
   */
  pctOfAvgPrice?: string;
};

export type StaffRole = "host" | "assistant";

export type ExpenseCategory =
  | "giveaways"
  | "advertising"
  | "packaging"
  | "shipping_labels"
  | "labor"
  | "bonuses"
  | "other";

export const EXPENSE_CATEGORIES: { id: ExpenseCategory; label: string }[] = [
  { id: "giveaways", label: "Giveaways" },
  { id: "advertising", label: "Advertising" },
  { id: "packaging", label: "Packaging" },
  { id: "shipping_labels", label: "Shipping labels" },
  { id: "labor", label: "Labor" },
  { id: "bonuses", label: "Bonuses" },
  { id: "other", label: "Other" },
];

/** A cost that accrues for every active minute of a show, prorated to the second. */
export type HourlyExpenseRule = { category: ExpenseCategory; label: string; perHour: string };

/** Which order timestamp places revenue on the show timeline. */
export type RevenueBasis = "created" | "paid";

/**
 * A frozen snapshot of every cost rule used for a show. Stored on the show at
 * start time so later settings changes never rewrite history.
 *
 * v2 fields (`presenter`, `assistant`, `hourlyExpenses`) are optional so that
 * snapshots saved before v2 (`host`, `assistantPerHour`, `marketingPerHour`)
 * keep calculating exactly as they did. Use `normalizeCosts` to read either.
 */
export type CostSnapshot = {
  version?: 2;
  defaultProductCost: string;
  skuCosts: Record<string, string>; // sku -> unit cost
  packingPerItem: string;
  percentFee: string; // fraction of product revenue, e.g. "0.06" for 6%
  fixedFeePerTransaction: string; // per chargeable transaction (order)

  // v2
  presenter?: CompRates;
  assistant?: CompRates;
  hourlyExpenses?: HourlyExpenseRule[];
  revenueBasis?: RevenueBasis;
  /** Estimated seller-paid shipping per package when the actual label cost is unknown. null = no estimate. */
  shippingEstimatePerPackage?: string | null;
  /**
   * End-of-show scan report. When present, the show's product cost is exactly
   * `totalCogs`: sold items are costed by UPC (= SKU) from the report, then scaled
   * so the show total matches the report.
   */
  scanReport?: { totalCogs: string; units: number; unitCosts: Record<string, string> } | null;

  // v1 (legacy snapshots only)
  host?: HostCompensation;
  assistantPerHour?: string;
  marketingPerHour?: string;
};

export type OrderItemInput = {
  externalItemId: string;
  sku: string | null;
  title: string;
  quantity: number;
  /** Price per unit before any discount. */
  unitPrice: string;
  /** Total seller-funded discount for this line (reduces seller revenue). */
  sellerDiscount: string;
  /** Total platform-funded discount for this line (does NOT reduce seller revenue). */
  platformDiscount: string;
};

export type RefundInput = {
  externalRefundId: string;
  externalItemId: string | null;
  quantity: number;
  amount: string; // merchandise amount refunded to the buyer, seller-borne
  refundedAt: string;
};

export type OrderInput = {
  externalOrderId: string;
  createdAt: string; // ISO UTC, platform order creation time
  paidAt?: string | null; // ISO UTC, payment time when reported
  receivedAt?: string; // ISO UTC, when we ingested it (for out-of-order detection)
  status: "active" | "cancelled";
  isTest: boolean;
  /** Stable platform buyer id, when the platform provides one. Never a display name. */
  customerId?: string | null;
  /** TikTok order_type: "AUCTION", "ZERO_LOTTERY", "" / "NORMAL" for buy-now, null = unknown. */
  orderType?: string | null;
  items: OrderItemInput[];
  refunds: RefundInput[];
  /** Shipping the buyer paid. Never merchandise revenue. */
  customerShipping: string;
  /** Platform-funded shipping subsidy, if reported. */
  platformShippingSubsidy: string | null;
  /** Actual shipping cost charged to the seller for this order, if known. null = unknown. */
  sellerShippingCost: string | null;
  /** GMV exactly as the platform reports it, if reported. */
  platformGmv: string | null;
  /** Actual platform fees (commission + transaction), if reported. null = estimate. */
  actualPlatformFees: string | null;
  /** Confirmed settlement/payout for this order, if reported. */
  settlementAmount: string | null;
};

/**
 * A physical shipment. One package can hold several orders (a buyer who bought
 * three times in one show gets one box) and its label is paid once.
 */
export type PackageInput = {
  externalPackageId: string;
  orderIds: string[]; // externalOrderId values
  /** Label cost charged to the seller for the whole package. null = not known yet. */
  labelCost: string | null;
  /** Shipping reimbursement/recovery credited to the seller for this package. */
  reimbursement: string;
};

export type ShowExpenseInput = {
  /** Legacy kinds are kept for older rows; new rows use `category`. */
  kind: "one_time" | "giveaway";
  category?: ExpenseCategory;
  description: string;
  amount: string;
  incurredAt: string;
};

export type PauseInput = { pausedAt: string; resumedAt: string | null };

/** One person working a show, with their own shift and frozen pay rates. */
export type StaffShift = {
  staffId: string | null;
  name: string;
  role: StaffRole;
  joinedAt: string | null; // null = show start
  leftAt: string | null; // null = show end
  comp: CompRates;
};

export type ShowInput = {
  startedAt: string;
  endedAt: string | null;
  pauses: PauseInput[];
  costs: CostSnapshot;
  expenses: ShowExpenseInput[];
  orders: OrderInput[];
  /**
   * Who worked the show. `undefined` (legacy shows) = one presenter and one
   * assistant on the snapshot's default rates for the whole show.
   * `[]` = nobody is paid.
   */
  staff?: StaffShift[];
  packages?: PackageInput[];
};
