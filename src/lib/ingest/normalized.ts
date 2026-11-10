import { z } from "zod";

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), "must be a decimal amount");
const nullableMoney = money.nullable().default(null);

/**
 * The single shape every platform adapter produces. Ingestion only ever sees
 * this — platform-specific quirks stay inside the adapters.
 */
export const NormalizedOrderSchema = z.object({
  platform: z.enum(["tiktok", "whatnot", "manual"]),
  externalOrderId: z.string().min(1).max(128),
  externalShopId: z.string().max(128).nullable().default(null),
  createdAt: z.iso.datetime({ offset: true }),
  paidAt: z.iso.datetime({ offset: true }).nullable().default(null),
  /** Stable platform buyer id (never a display name). */
  customerId: z.string().max(128).nullable().default(null),
  customerName: z.string().max(200).nullable().default(null),
  /** LIVE session id from the platform. null = not reported; "" = platform says not from a LIVE. */
  liveRoomId: z.string().max(128).nullable().default(null),
  /** Package ids this order ships in (from the platform). */
  packageIds: z.array(z.string().max(128)).default([]),
  source: z.enum(["webhook", "import", "manual", "test"]).default("webhook"),
  status: z.enum(["active", "cancelled"]),
  platformStatus: z.string().max(64).nullable().default(null),
  isTest: z.boolean(),
  currency: z.string().length(3).default("USD"),
  items: z
    .array(
      z.object({
        externalItemId: z.string().min(1).max(128),
        sku: z.string().max(128).nullable(),
        title: z.string().max(500),
        quantity: z.number().int().min(0).max(10_000),
        unitPrice: money,
        sellerDiscount: money.default("0"),
        platformDiscount: money.default("0"),
      }),
    )
    .min(1)
    .max(500),
  refunds: z
    .array(
      z.object({
        externalRefundId: z.string().min(1).max(128),
        externalItemId: z.string().max(128).nullable().default(null),
        quantity: z.number().int().min(0),
        amount: money,
        refundedAt: z.iso.datetime({ offset: true }),
      }),
    )
    .default([]),
  customerShipping: money.default("0"),
  platformShippingSubsidy: nullableMoney,
  sellerShippingCost: nullableMoney,
  platformGmv: nullableMoney,
  actualPlatformFees: nullableMoney,
  settlementAmount: nullableMoney,
  raw: z.unknown().optional(),
});

export type NormalizedOrder = z.output<typeof NormalizedOrderSchema>;
export type NormalizedOrderInput = z.input<typeof NormalizedOrderSchema>;
