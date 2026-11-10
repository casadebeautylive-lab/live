-- Atomic order ingestion: order row, items and refunds change in one transaction,
-- so the dashboard never sees an order without its items.
create or replace function public.ingest_order(p jsonb, p_show uuid)
returns table (out_order_id uuid, out_created boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_existing orders;
  v_order uuid;
  v_shop uuid;
begin
  select * into v_existing from orders
   where platform = (p->>'platform')::platform and external_order_id = p->>'externalOrderId'
   for update;

  -- test data can never overwrite a real order (or vice versa)
  if v_existing.id is not null and v_existing.is_test <> (p->>'isTest')::boolean then
    raise exception 'order % exists with a different test/real flag', p->>'externalOrderId';
  end if;

  if p->>'externalShopId' is not null then
    select id into v_shop from shops
     where platform = (p->>'platform')::platform and external_shop_id = p->>'externalShopId';
  end if;

  insert into orders as o (
    platform, external_order_id, shop_id, show_id, status, platform_status, is_test, currency,
    created_at_platform, updated_at, customer_shipping, platform_shipping_subsidy, seller_shipping_cost,
    platform_gmv, actual_platform_fees, settlement_amount, raw
  ) values (
    (p->>'platform')::platform, p->>'externalOrderId', v_shop, p_show, (p->>'status')::order_status,
    p->>'platformStatus', (p->>'isTest')::boolean, coalesce(p->>'currency', 'USD'),
    (p->>'createdAt')::timestamptz, now(), coalesce((p->>'customerShipping')::numeric, 0),
    (p->>'platformShippingSubsidy')::numeric, (p->>'sellerShippingCost')::numeric,
    (p->>'platformGmv')::numeric, (p->>'actualPlatformFees')::numeric, (p->>'settlementAmount')::numeric,
    p->'raw'
  )
  on conflict (platform, external_order_id) do update set
    shop_id = coalesce(excluded.shop_id, o.shop_id),
    show_id = coalesce(o.show_id, excluded.show_id),   -- never move an assigned order
    status = excluded.status,
    platform_status = excluded.platform_status,
    currency = excluded.currency,
    created_at_platform = excluded.created_at_platform,
    updated_at = now(),
    customer_shipping = excluded.customer_shipping,
    platform_shipping_subsidy = excluded.platform_shipping_subsidy,
    seller_shipping_cost = excluded.seller_shipping_cost,
    platform_gmv = excluded.platform_gmv,
    actual_platform_fees = excluded.actual_platform_fees,
    settlement_amount = coalesce(excluded.settlement_amount, o.settlement_amount),
    raw = excluded.raw
  returning o.id into v_order;

  -- latest platform view of line items is authoritative
  delete from order_items where order_items.order_id = v_order;
  insert into order_items (order_id, external_item_id, sku, title, quantity, unit_price, seller_discount, platform_discount, product_id)
  select v_order, i->>'externalItemId', nullif(i->>'sku', ''), i->>'title', (i->>'quantity')::int,
         (i->>'unitPrice')::numeric, coalesce((i->>'sellerDiscount')::numeric, 0),
         coalesce((i->>'platformDiscount')::numeric, 0),
         (select pr.id from products pr where pr.sku = nullif(i->>'sku', ''))
    from jsonb_array_elements(p->'items') i;

  -- refunds accumulate (a refund never disappears once reported)
  insert into refunds (order_id, external_refund_id, external_item_id, quantity, amount, refunded_at)
  select v_order, r->>'externalRefundId', r->>'externalItemId', coalesce((r->>'quantity')::int, 0),
         (r->>'amount')::numeric, (r->>'refundedAt')::timestamptz
    from jsonb_array_elements(coalesce(p->'refunds', '[]'::jsonb)) r
  on conflict (order_id, external_refund_id) do update set
    quantity = excluded.quantity, amount = excluded.amount, refunded_at = excluded.refunded_at;

  return query select v_order, v_existing.id is null;
end $$;
revoke execute on function public.ingest_order(jsonb, uuid) from public, anon, authenticated;
