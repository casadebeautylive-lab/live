-- Jewelar LIVE Profit Tracker — schema v2 (additive; nothing existing is dropped)
--
--  * show lifecycle: scheduled → live/paused → ended → awaiting_reconciliation → finalized
--  * TikTok LIVE auto-detection via line_items[].room_id (live_room_id on shows and orders)
--  * order ↔ show attribution with "needs review" and a full decision log
--  * staff shifts with their own start/end and frozen pay rates
--  * customers, packages (many-to-many with orders), finance transactions
--  * frozen per-minute history at show end, sync jobs
--  * new cost defaults ($2.50 product, $1/unit presenter, $20/h assistant, 6%, $30/h giveaways)

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
alter type show_status add value if not exists 'scheduled';
alter type show_status add value if not exists 'awaiting_reconciliation';
alter type show_status add value if not exists 'finalized';

create type attribution_status as enum ('assigned', 'unassigned', 'needs_review', 'not_live');

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
alter table app_settings
  add column attribution_before_minutes integer not null default 0 check (attribution_before_minutes between 0 and 120),
  add column attribution_after_minutes integer not null default 5 check (attribution_after_minutes between 0 and 240),
  add column auto_show_idle_minutes integer not null default 20 check (auto_show_idle_minutes between 5 and 240),
  add column revenue_basis text not null default 'created' check (revenue_basis in ('created', 'paid'));

-- ---------------------------------------------------------------------------
-- Cost profiles: v2 fields and the new defaults
-- ---------------------------------------------------------------------------
alter table cost_profiles
  add column presenter_percent_of_sales numeric(8,6) not null default 0 check (presenter_percent_of_sales >= 0 and presenter_percent_of_sales < 1),
  add column hourly_expenses jsonb not null default '[{"category":"giveaways","label":"Giveaways / misc.","perHour":"30.00"}]'::jsonb,
  add column shipping_estimate_per_package numeric(14,4) check (shipping_estimate_per_package >= 0);

alter table cost_profiles
  alter column default_product_cost set default 2.50,
  alter column packing_per_item set default 0,
  alter column marketing_per_hour set default 0;
alter table fee_rules
  alter column percent_fee set default 0.06,
  alter column fixed_fee_per_transaction set default 0;

-- Move active profiles still on the original defaults to the new defaults.
-- Profiles you already edited are left alone; past shows keep their snapshots.
update cost_profiles set
  default_product_cost = 2.50, packing_per_item = 0, marketing_per_hour = 0
 where is_active and default_product_cost = 2.00 and packing_per_item = 0.20 and marketing_per_hour = 35.00;
update fee_rules set percent_fee = 0.06, fixed_fee_per_transaction = 0
 where is_active and percent_fee = 0.074 and fixed_fee_per_transaction = 0.30;

-- ---------------------------------------------------------------------------
-- Staff & shifts
-- ---------------------------------------------------------------------------
alter table staff
  add column percent_of_sales numeric(8,6) check (percent_of_sales >= 0 and percent_of_sales < 1);

-- show_staff becomes one row per shift: own start/end and frozen pay rates.
alter table show_staff drop constraint show_staff_pkey;
alter table show_staff
  add column id uuid not null default gen_random_uuid(),
  add column name text,
  add column joined_at timestamptz,
  add column left_at timestamptz,
  add column comp jsonb,          -- CompRates frozen when assigned; null = use the show snapshot's role default
  add column created_at timestamptz not null default now(),
  add constraint show_staff_shift_order check (left_at is null or joined_at is null or left_at >= joined_at);
alter table show_staff add primary key (id);
alter table show_staff alter column staff_id drop not null;
create index show_staff_show on show_staff (show_id);
create index show_staff_staff on show_staff (staff_id);

-- ---------------------------------------------------------------------------
-- Shows
-- ---------------------------------------------------------------------------
alter table live_shows
  add column live_room_id text,                 -- TikTok LIVE session id (room_id)
  add column scheduled_start timestamptz,
  add column scheduled_end timestamptz,
  add column last_activity_at timestamptz,      -- last attributed order (drives auto-end of detected shows)
  add column times_verified boolean not null default false, -- start/end confirmed from TikTok LIVE analytics
  add column platform_stats jsonb,              -- TikTok LIVE analytics (GMV, viewers…) as reported
  add column original_estimate jsonb,           -- totals frozen at show end, before reconciliation
  add column reconciled_at timestamptz,
  add column finalized_at timestamptz,
  add column notes text;
create unique index live_shows_room on live_shows (platform, live_room_id) where live_room_id is not null;

-- One manually-run show at a time per platform; detected LIVEs are keyed by room id instead.
drop index live_shows_one_running;
create unique index live_shows_one_running on live_shows (platform, is_test)
  where status in ('live', 'paused') and detection = 'manual';

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
create table customers (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  external_customer_id text not null,   -- stable platform buyer id; display names are NOT identifiers
  display_name text,                    -- only when the platform provides it
  first_order_at timestamptz,
  last_order_at timestamptz,
  created_at timestamptz not null default now(),
  unique (platform, external_customer_id)
);

-- ---------------------------------------------------------------------------
-- Orders: attribution, customer, payment time
-- ---------------------------------------------------------------------------
alter table orders
  add column customer_id uuid references customers (id) on delete set null,
  add column paid_at timestamptz,
  add column live_room_id text,         -- '' = platform says not from a LIVE; null = not reported
  add column attribution attribution_status not null default 'unassigned',
  add column attribution_method text check (attribution_method in ('platform_live_id', 'time_window', 'manual')),
  add column attribution_note text;
update orders set attribution = 'assigned', attribution_method = 'time_window' where show_id is not null;
create index orders_customer on orders (customer_id);
create index orders_attribution on orders (attribution) where attribution in ('needs_review', 'unassigned');

create table order_show_attributions (
  id bigint generated always as identity primary key,
  order_id uuid not null references orders (id) on delete cascade,
  show_id uuid references live_shows (id) on delete set null,
  status attribution_status not null,
  method text,
  note text,
  candidate_show_ids uuid[],
  decided_by uuid references users (id),  -- null = automatic
  created_at timestamptz not null default now()
);
create index order_show_attributions_order on order_show_attributions (order_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Packages (one package may hold several orders, one order may ship in several packages)
-- ---------------------------------------------------------------------------
create table packages (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  external_package_id text not null,
  status text,
  carrier text,
  tracking_number text,
  label_cost numeric(14,4),                       -- seller-paid label for the whole package; null = unknown
  label_cost_source text check (label_cost_source in ('estimate', 'label', 'settlement')),
  reimbursement numeric(14,4) not null default 0, -- shipping credits back to the seller
  currency text not null default 'USD',
  shipped_at timestamptz,
  raw jsonb,
  updated_at timestamptz not null default now(),
  unique (platform, external_package_id)
);

create table package_orders (
  package_id uuid not null references packages (id) on delete cascade,
  order_id uuid not null references orders (id) on delete cascade,
  primary key (package_id, order_id)
);
create index package_orders_order on package_orders (order_id);

-- ---------------------------------------------------------------------------
-- Finance transactions (order-level statement lines, signed: + credit, − charge)
-- ---------------------------------------------------------------------------
create table finance_transactions (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  external_transaction_id text not null,
  order_id uuid references orders (id) on delete set null,
  external_order_id text,
  statement_id text,
  type text not null,                    -- e.g. ORDER, REFUND, SHIPPING_ADJUSTMENT
  settled boolean not null default false,
  revenue_amount numeric(14,4),
  platform_fee_amount numeric(14,4),     -- commission + transaction + referral (signed)
  shipping_cost_amount numeric(14,4),    -- actual seller shipping (signed)
  settlement_amount numeric(14,4),       -- net proceeds of this line
  currency text not null default 'USD',
  occurred_at timestamptz,
  raw jsonb not null,
  created_at timestamptz not null default now(),
  unique (platform, external_transaction_id)
);
create index finance_transactions_order on finance_transactions (order_id);

-- ---------------------------------------------------------------------------
-- Show expenses: categories
-- ---------------------------------------------------------------------------
alter table show_expenses
  add column category text check (category in ('giveaways', 'advertising', 'packaging', 'shipping_labels', 'labor', 'bonuses', 'other'));
update show_expenses set category = case when kind = 'giveaway' then 'giveaways' else 'other' end where category is null;

-- ---------------------------------------------------------------------------
-- Frozen per-minute history (original live estimate, captured at show end)
-- ---------------------------------------------------------------------------
create table show_minute_metrics (
  show_id uuid not null references live_shows (id) on delete cascade,
  view text not null default 'original' check (view in ('original')),
  minute_index integer not null check (minute_index >= 0),
  minute_start timestamptz not null,
  active_seconds integer not null,
  orders integer not null,
  units integer not null,
  revenue numeric(14,4) not null,
  cogs numeric(14,4) not null,
  commission numeric(14,4) not null,
  fees numeric(14,4) not null,
  labor numeric(14,4) not null,
  hourly_expenses numeric(14,4) not null,
  fixed_expenses numeric(14,4) not null,
  packing numeric(14,4) not null,
  shipping numeric(14,4) not null,
  profit numeric(14,4) not null,
  cumulative_profit numeric(14,4) not null,
  primary key (show_id, view, minute_index)
);

-- ---------------------------------------------------------------------------
-- Sync jobs
-- ---------------------------------------------------------------------------
create table sync_jobs (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  kind text not null check (kind in ('orders', 'finance', 'packages', 'live_sessions', 'close_idle_shows', 'reconcile')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  cursor text,
  stats jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index sync_jobs_recent on sync_jobs (kind, started_at desc);

-- ---------------------------------------------------------------------------
-- RLS for new tables (members read; finance/packages/customers are server-written)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['customers','order_show_attributions','packages','package_orders','finance_transactions','show_minute_metrics','sync_jobs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select to authenticated using (public.is_member())', t || '_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Show window re-attribution (manual shows): attach unassigned orders with no
-- LIVE id that fall inside exactly this show's window; flag overlaps for review.
-- ---------------------------------------------------------------------------
create or replace function public.assign_orders_to_show(p_show uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  s live_shows; n integer; cfg app_settings;
  v_from timestamptz; v_to timestamptz;
begin
  select * into s from live_shows where id = p_show;
  if s is null then return 0; end if;
  select * into cfg from app_settings where id = 1;
  v_from := s.started_at - make_interval(mins => cfg.attribution_before_minutes);
  v_to := coalesce(s.ended_at, now()) + make_interval(mins => cfg.attribution_after_minutes);

  with cand as (
    select o.id,
           (select count(*) from live_shows x
             where x.id <> s.id and x.is_test = o.is_test
               and (x.platform = 'manual' or x.platform = o.platform)
               and o.created_at_platform >= x.started_at - make_interval(mins => cfg.attribution_before_minutes)
               and o.created_at_platform <= coalesce(x.ended_at, now()) + make_interval(mins => cfg.attribution_after_minutes)
           ) as others
      from orders o
     where o.show_id is null
       and o.attribution = 'unassigned'
       and o.live_room_id is null
       and o.is_test = s.is_test
       and (s.platform = 'manual' or o.platform = s.platform)
       and o.created_at_platform between v_from and v_to
  ), upd as (
    update orders o set
      show_id = case when c.others = 0 then s.id else null end,
      attribution = case when c.others = 0 then 'assigned'::attribution_status else 'needs_review'::attribution_status end,
      attribution_method = case when c.others = 0 then 'time_window' else null end,
      attribution_note = case when c.others = 0 then 'Order time falls inside this show''s window'
                              else 'Order time overlaps more than one show window' end
      from cand c where o.id = c.id
    returning o.id, o.show_id, o.attribution, o.attribution_method, o.attribution_note
  )
  insert into order_show_attributions (order_id, show_id, status, method, note)
  select id, show_id, attribution, attribution_method, attribution_note from upd;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.assign_orders_to_show(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- Ingestion v3: attribution decision, customer and payment time.
-- p_attr = {"status": attribution_status, "method": text|null, "note": text, "candidates": [uuid]}
-- An order already assigned to a show is never moved automatically.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_order_v3(p jsonb, p_show uuid, p_attr jsonb)
returns table (out_order_id uuid, out_created boolean, out_show_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_existing orders;
  v_order uuid;
  v_shop uuid;
  v_customer uuid;
  v_status attribution_status := coalesce((p_attr->>'status')::attribution_status, 'unassigned');
  v_show uuid := p_show;
  v_keep boolean;
begin
  select * into v_existing from orders
   where platform = (p->>'platform')::platform and external_order_id = p->>'externalOrderId'
   for update;

  if v_existing.id is not null and v_existing.is_test <> (p->>'isTest')::boolean then
    raise exception 'order % exists with a different test/real flag', p->>'externalOrderId';
  end if;

  if p->>'externalShopId' is not null then
    select id into v_shop from shops
     where platform = (p->>'platform')::platform and external_shop_id = p->>'externalShopId';
  end if;

  if nullif(p->>'customerId', '') is not null then
    insert into customers as c (platform, external_customer_id, display_name, first_order_at, last_order_at)
    values ((p->>'platform')::platform, p->>'customerId', nullif(p->>'customerName', ''),
            (p->>'createdAt')::timestamptz, (p->>'createdAt')::timestamptz)
    on conflict (platform, external_customer_id) do update set
      display_name = coalesce(excluded.display_name, c.display_name),
      first_order_at = least(c.first_order_at, excluded.first_order_at),
      last_order_at = greatest(c.last_order_at, excluded.last_order_at)
    returning c.id into v_customer;
  end if;

  -- keep an existing assignment (manual or automatic); only unassigned/review orders can be re-decided
  v_keep := v_existing.id is not null and v_existing.show_id is not null;
  if v_keep then
    v_show := v_existing.show_id;
  end if;

  insert into orders as o (
    platform, external_order_id, shop_id, show_id, status, platform_status, is_test, currency,
    created_at_platform, paid_at, updated_at, customer_shipping, platform_shipping_subsidy, seller_shipping_cost,
    platform_gmv, actual_platform_fees, settlement_amount, raw, customer_id, live_room_id,
    attribution, attribution_method, attribution_note
  ) values (
    (p->>'platform')::platform, p->>'externalOrderId', v_shop, v_show, (p->>'status')::order_status,
    p->>'platformStatus', (p->>'isTest')::boolean, coalesce(p->>'currency', 'USD'),
    (p->>'createdAt')::timestamptz, (p->>'paidAt')::timestamptz, now(), coalesce((p->>'customerShipping')::numeric, 0),
    (p->>'platformShippingSubsidy')::numeric, (p->>'sellerShippingCost')::numeric,
    (p->>'platformGmv')::numeric, (p->>'actualPlatformFees')::numeric, (p->>'settlementAmount')::numeric,
    p->'raw', v_customer, p->>'liveRoomId',
    case when v_show is not null then 'assigned'::attribution_status else v_status end,
    p_attr->>'method', p_attr->>'note'
  )
  on conflict (platform, external_order_id) do update set
    shop_id = coalesce(excluded.shop_id, o.shop_id),
    show_id = coalesce(o.show_id, excluded.show_id),
    status = excluded.status,
    platform_status = excluded.platform_status,
    currency = excluded.currency,
    created_at_platform = excluded.created_at_platform,
    paid_at = coalesce(excluded.paid_at, o.paid_at),
    updated_at = now(),
    customer_shipping = excluded.customer_shipping,
    platform_shipping_subsidy = excluded.platform_shipping_subsidy,
    seller_shipping_cost = coalesce(excluded.seller_shipping_cost, o.seller_shipping_cost),
    platform_gmv = coalesce(excluded.platform_gmv, o.platform_gmv),
    actual_platform_fees = coalesce(excluded.actual_platform_fees, o.actual_platform_fees),
    settlement_amount = coalesce(excluded.settlement_amount, o.settlement_amount),
    raw = excluded.raw,
    customer_id = coalesce(excluded.customer_id, o.customer_id),
    live_room_id = coalesce(excluded.live_room_id, o.live_room_id),
    attribution = case when o.show_id is not null then o.attribution else excluded.attribution end,
    attribution_method = case when o.show_id is not null then o.attribution_method else excluded.attribution_method end,
    attribution_note = case when o.show_id is not null then o.attribution_note else excluded.attribution_note end
  returning o.id into v_order;

  delete from order_items where order_items.order_id = v_order;
  insert into order_items (order_id, external_item_id, sku, title, quantity, unit_price, seller_discount, platform_discount, product_id)
  select v_order, i->>'externalItemId', nullif(i->>'sku', ''), i->>'title', (i->>'quantity')::int,
         (i->>'unitPrice')::numeric, coalesce((i->>'sellerDiscount')::numeric, 0),
         coalesce((i->>'platformDiscount')::numeric, 0),
         (select pr.id from products pr where pr.sku = nullif(i->>'sku', ''))
    from jsonb_array_elements(p->'items') i;

  insert into refunds (order_id, external_refund_id, external_item_id, quantity, amount, refunded_at)
  select v_order, r->>'externalRefundId', r->>'externalItemId', coalesce((r->>'quantity')::int, 0),
         (r->>'amount')::numeric, (r->>'refundedAt')::timestamptz
    from jsonb_array_elements(coalesce(p->'refunds', '[]'::jsonb)) r
  on conflict (order_id, external_refund_id) do update set
    quantity = excluded.quantity, amount = excluded.amount, refunded_at = excluded.refunded_at;

  -- log the decision for new or still-unassigned orders
  if not v_keep then
    insert into order_show_attributions (order_id, show_id, status, method, note, candidate_show_ids)
    select v_order, v_show, case when v_show is not null then 'assigned'::attribution_status else v_status end,
           p_attr->>'method', p_attr->>'note',
           (select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_attr->'candidates', '[]'::jsonb)) x);
  end if;

  if v_show is not null then
    update live_shows set last_activity_at = greatest(coalesce(last_activity_at, (p->>'createdAt')::timestamptz), (p->>'createdAt')::timestamptz)
     where id = v_show;
  end if;

  return query select v_order, v_existing.id is null, v_show;
end $$;
revoke execute on function public.ingest_order_v3(jsonb, uuid, jsonb) from public, anon, authenticated;

-- Package upsert with its order links (by platform order id).
create or replace function public.upsert_package(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_pkg uuid;
begin
  insert into packages as k (platform, external_package_id, status, carrier, tracking_number, label_cost, label_cost_source,
                             reimbursement, currency, shipped_at, raw, updated_at)
  values ((p->>'platform')::platform, p->>'externalPackageId', p->>'status', p->>'carrier', p->>'trackingNumber',
          (p->>'labelCost')::numeric, p->>'labelCostSource', coalesce((p->>'reimbursement')::numeric, 0),
          coalesce(p->>'currency', 'USD'), (p->>'shippedAt')::timestamptz, p->'raw', now())
  on conflict (platform, external_package_id) do update set
    status = excluded.status, carrier = coalesce(excluded.carrier, k.carrier),
    tracking_number = coalesce(excluded.tracking_number, k.tracking_number),
    -- a label or settlement cost always replaces an estimate; never the other way round
    label_cost = case when excluded.label_cost is null then k.label_cost
                      when k.label_cost_source = 'settlement' and excluded.label_cost_source <> 'settlement' then k.label_cost
                      else excluded.label_cost end,
    label_cost_source = case when excluded.label_cost is null then k.label_cost_source
                             when k.label_cost_source = 'settlement' and excluded.label_cost_source <> 'settlement' then k.label_cost_source
                             else excluded.label_cost_source end,
    reimbursement = excluded.reimbursement, shipped_at = coalesce(excluded.shipped_at, k.shipped_at),
    raw = excluded.raw, updated_at = now()
  returning k.id into v_pkg;

  delete from package_orders where package_id = v_pkg;
  insert into package_orders (package_id, order_id)
  select v_pkg, o.id from orders o
   where o.platform = (p->>'platform')::platform
     and o.external_order_id in (select jsonb_array_elements_text(coalesce(p->'orderIds', '[]'::jsonb)))
  on conflict do nothing;
  return v_pkg;
end $$;
revoke execute on function public.upsert_package(jsonb) from public, anon, authenticated;

alter publication supabase_realtime add table show_staff;
