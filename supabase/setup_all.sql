-- One-time setup for a new Supabase project: all migrations 0001–0008 in order.
-- Paste this whole file into Supabase → SQL Editor → Run.

-- ===== supabase/migrations/0001_init.sql =====
-- Jewelar Live Intelligence — initial schema
-- Run in Supabase SQL editor or with `supabase db push`.
-- Money is numeric(14,4); all timestamps are timestamptz (stored UTC).

-- gen_random_uuid() is built into Postgres 13+ (Supabase runs 15+).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type platform as enum ('tiktok', 'whatnot', 'manual');
create type connection_status as enum ('connected', 'pending_access', 'disconnected', 'error');
create type show_status as enum ('live', 'paused', 'ended');
create type order_status as enum ('active', 'cancelled');
create type webhook_status as enum ('received', 'processed', 'duplicate', 'failed', 'rejected');
create type expense_kind as enum ('one_time', 'giveaway');
create type staff_role as enum ('host', 'assistant');

-- ---------------------------------------------------------------------------
-- Users & roles
-- ---------------------------------------------------------------------------
create table roles (
  id text primary key,                   -- 'owner' | 'admin' | 'viewer'
  description text not null,
  can_write boolean not null default false
);
insert into roles (id, description, can_write) values
  ('owner', 'Full access including user management and recalculation', true),
  ('admin', 'Manage shows, costs and integrations', true),
  ('viewer', 'Read-only dashboard access', false);

create table users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text,
  role_id text not null references roles (id) default 'viewer',
  created_at timestamptz not null default now()
);

create table app_settings (
  id smallint primary key default 1 check (id = 1),
  timezone text not null default 'America/New_York',
  updated_at timestamptz not null default now()
);
insert into app_settings (id) values (1);

-- Helper functions used by RLS. security definer so they can read users table.
create or replace function public.current_role_id() returns text
language sql stable security definer set search_path = public as $$
  select role_id from users where id = auth.uid()
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from users where id = auth.uid())
$$;

create or replace function public.can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.can_write from users u join roles r on r.id = u.role_id where u.id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------------
create table platform_connections (
  id uuid primary key default gen_random_uuid(),
  platform platform not null unique,
  status connection_status not null default 'pending_access',
  -- tokens are AES-256-GCM encrypted by the server (TOKEN_ENCRYPTION_KEY); never readable by clients
  access_token_enc text,
  refresh_token_enc text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scopes text[],
  last_sync_at timestamptz,
  last_event_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into platform_connections (platform, status) values
  ('tiktok', 'pending_access'),
  ('whatnot', 'pending_access');

create table shops (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  connection_id uuid references platform_connections (id) on delete set null,
  external_shop_id text not null,
  shop_cipher text,                      -- TikTok shop_cipher (not secret, but server-only)
  name text,
  region text,
  created_at timestamptz not null default now(),
  unique (platform, external_shop_id)
);

-- ---------------------------------------------------------------------------
-- Costs (versioned; shows snapshot the active profile at start)
-- ---------------------------------------------------------------------------
create table cost_profiles (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,            -- one active profile per platform
  name text not null,
  default_product_cost numeric(14,4) not null default 2.00 check (default_product_cost >= 0),
  host_per_item numeric(14,4) not null default 1.00 check (host_per_item >= 0),
  host_per_hour numeric(14,4) not null default 0 check (host_per_hour >= 0),
  host_flat_per_show numeric(14,4) not null default 0 check (host_flat_per_show >= 0),
  packing_per_item numeric(14,4) not null default 0.20 check (packing_per_item >= 0),
  assistant_per_hour numeric(14,4) not null default 20.00 check (assistant_per_hour >= 0),
  marketing_per_hour numeric(14,4) not null default 35.00 check (marketing_per_hour >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references users (id)
);
create unique index cost_profiles_one_active on cost_profiles (platform) where is_active;

create table fee_rules (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  percent_fee numeric(8,6) not null default 0.074 check (percent_fee >= 0 and percent_fee < 1),
  fixed_fee_per_transaction numeric(14,4) not null default 0.30 check (fixed_fee_per_transaction >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references users (id)
);
create unique index fee_rules_one_active on fee_rules (platform) where is_active;

insert into cost_profiles (platform, name) values
  ('tiktok', 'TikTok default'), ('whatnot', 'Whatnot default'), ('manual', 'Manual default');
insert into fee_rules (platform) values ('tiktok'), ('whatnot'), ('manual');

create table products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,              -- seller SKU, shared across platforms
  title text,
  created_at timestamptz not null default now()
);

create table product_costs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id) on delete cascade,
  unit_cost numeric(14,4) not null check (unit_cost >= 0),
  effective_from timestamptz not null default now(),
  created_by uuid references users (id)
);
create index product_costs_lookup on product_costs (product_id, effective_from desc);

-- ---------------------------------------------------------------------------
-- Staff & shows
-- ---------------------------------------------------------------------------
create table staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role staff_role not null,
  -- optional per-person compensation overriding the cost profile when assigned as host
  host_per_item numeric(14,4),
  host_per_hour numeric(14,4),
  host_flat_per_show numeric(14,4),
  hourly_rate numeric(14,4),             -- for assistants
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table live_shows (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  shop_id uuid references shops (id),
  title text not null,
  status show_status not null default 'live',
  detection text not null default 'manual' check (detection in ('manual', 'platform')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  is_test boolean not null default false,
  -- frozen copy of every cost rule in effect when the show started (CostSnapshot JSON)
  cost_snapshot jsonb not null,
  cost_profile_id uuid references cost_profiles (id),
  fee_rule_id uuid references fee_rules (id),
  recalculated_at timestamptz,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index live_shows_started on live_shows (started_at desc);
-- at most one running show per platform+test-mode
create unique index live_shows_one_running on live_shows (platform, is_test) where status <> 'ended';

create table show_pauses (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references live_shows (id) on delete cascade,
  paused_at timestamptz not null default now(),
  resumed_at timestamptz,
  check (resumed_at is null or resumed_at >= paused_at)
);
create index show_pauses_show on show_pauses (show_id);

create table show_staff (
  show_id uuid not null references live_shows (id) on delete cascade,
  staff_id uuid not null references staff (id),
  role staff_role not null,
  primary key (show_id, staff_id, role)
);

create table show_expenses (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references live_shows (id) on delete cascade,
  kind expense_kind not null,
  description text not null,
  amount numeric(14,4) not null check (amount >= 0),
  incurred_at timestamptz not null default now(),
  created_by uuid references users (id)
);
create index show_expenses_show on show_expenses (show_id);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
create table orders (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  shop_id uuid references shops (id),
  show_id uuid references live_shows (id) on delete set null,
  external_order_id text not null,
  status order_status not null default 'active',
  platform_status text,                  -- raw platform status string
  is_test boolean not null default false,
  currency text not null default 'USD',
  created_at_platform timestamptz not null,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  customer_shipping numeric(14,4) not null default 0,
  platform_shipping_subsidy numeric(14,4),
  seller_shipping_cost numeric(14,4),
  platform_gmv numeric(14,4),
  actual_platform_fees numeric(14,4),
  settlement_amount numeric(14,4),
  raw jsonb,
  unique (platform, external_order_id)   -- idempotency: one row per platform order
);
create index orders_show on orders (show_id);
create index orders_created on orders (created_at_platform desc);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  external_item_id text not null,
  product_id uuid references products (id),
  sku text,
  title text not null,
  quantity integer not null check (quantity >= 0),
  unit_price numeric(14,4) not null,
  seller_discount numeric(14,4) not null default 0,
  platform_discount numeric(14,4) not null default 0,
  unique (order_id, external_item_id)
);
create index order_items_sku on order_items (sku);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  external_refund_id text not null,
  external_item_id text,
  quantity integer not null default 0 check (quantity >= 0),
  amount numeric(14,4) not null check (amount >= 0),
  refunded_at timestamptz not null,
  unique (order_id, external_refund_id)
);

create table settlements (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  order_id uuid references orders (id) on delete cascade,
  external_settlement_id text not null,
  amount numeric(14,4) not null,
  fees numeric(14,4),
  settled_at timestamptz,
  raw jsonb,
  unique (platform, external_settlement_id)
);

-- ---------------------------------------------------------------------------
-- Ingestion log (every inbound event, deduplicated)
-- ---------------------------------------------------------------------------
create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  idempotency_key text not null,
  event_type text not null,
  status webhook_status not null default 'received',
  signature_valid boolean not null,
  is_test boolean not null default false,
  attempts integer not null default 0,
  payload jsonb not null,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (platform, idempotency_key)
);
create index webhook_events_status on webhook_events (status, received_at desc);

-- ---------------------------------------------------------------------------
-- Alerts & audit
-- ---------------------------------------------------------------------------
create table alert_rules (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in
    ('no_sale_minutes', 'profit_per_hour_below', 'margin_below_pct', 'items_per_hour_below', 'show_unprofitable')),
  threshold numeric(14,4) not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind)
);
insert into alert_rules (kind, threshold) values
  ('no_sale_minutes', 5),
  ('profit_per_hour_below', 200),
  ('margin_below_pct', 30),
  ('items_per_hour_below', 40),
  ('show_unprofitable', 0);

create table notification_events (
  id uuid primary key default gen_random_uuid(),
  show_id uuid references live_shows (id) on delete cascade,
  rule_id uuid references alert_rules (id) on delete set null,
  kind text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  message text not null,
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notification_events_recent on notification_events (created_at desc);

create table audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references users (id),
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_recent on audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
-- Members read business data; writers modify it. Webhooks and token storage
-- run server-side with the service role, which bypasses RLS.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'roles','users','app_settings','platform_connections','shops','cost_profiles','fee_rules','products',
    'product_costs','staff','live_shows','show_pauses','show_staff','show_expenses','orders','order_items',
    'refunds','settlements','webhook_events','alert_rules','notification_events','audit_logs'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;

  -- read for members
  foreach t in array array[
    'roles','users','app_settings','shops','cost_profiles','fee_rules','products','product_costs','staff',
    'live_shows','show_pauses','show_staff','show_expenses','orders','order_items','refunds','settlements',
    'webhook_events','alert_rules','notification_events','audit_logs'
  ] loop
    execute format('create policy %I on %I for select to authenticated using (public.is_member())', t || '_read', t);
  end loop;

  -- write for owner/admin (orders/refunds/settlements/webhooks/audit are written by the server only)
  foreach t in array array[
    'app_settings','cost_profiles','fee_rules','products','product_costs','staff','live_shows','show_pauses',
    'show_staff','show_expenses','alert_rules','notification_events'
  ] loop
    execute format('create policy %I on %I for all to authenticated using (public.can_write()) with check (public.can_write())', t || '_write', t);
  end loop;
end $$;

-- Connections: expose status columns only, never token columns.
revoke select on platform_connections from authenticated, anon;
grant select (id, platform, status, scopes, last_sync_at, last_event_at, last_error, last_error_at, updated_at)
  on platform_connections to authenticated;
create policy platform_connections_read on platform_connections for select to authenticated using (public.is_member());

-- Only owners change roles.
create policy users_owner_write on users for update to authenticated
  using (public.current_role_id() = 'owner') with check (public.current_role_id() = 'owner');

-- ---------------------------------------------------------------------------
-- Show assignment: attach orders created inside a show's window to that show.
-- Test orders only attach to test shows, real orders only to real shows.
-- ---------------------------------------------------------------------------
create or replace function public.assign_orders_to_show(p_show uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare s live_shows; n integer;
begin
  select * into s from live_shows where id = p_show;
  if s is null then return 0; end if;
  update orders o set show_id = s.id
   where o.show_id is null
     and o.is_test = s.is_test
     and (s.platform = 'manual' or o.platform = s.platform)
     and o.created_at_platform >= s.started_at
     and (s.ended_at is null or o.created_at_platform <= s.ended_at);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.assign_orders_to_show(uuid) from public, anon;

-- Auto-provision a users row on signup. First user becomes owner; later users are viewers
-- (signups should be disabled in Supabase Auth after the owner account exists).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into users (id, email, role_id)
  values (new.id, new.email, case when (select count(*) from users) = 0 then 'owner' else 'viewer' end);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  orders, live_shows, show_pauses, show_expenses, notification_events;

-- ===== supabase/migrations/0002_ingest_function.sql =====
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

-- ===== supabase/migrations/0003_profit_tracker.sql =====
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

-- ===== supabase/migrations/0004_order_type.sql =====
-- TikTok order type (AUCTION, ZERO_LOTTERY, PRE_ORDER, … or empty for normal buy-now).
-- Used to average prices over auction items only and to recognise LIVE lottery giveaways.
-- Derived from the raw TikTok order on every insert/update, and backfilled for existing orders.

alter table orders add column if not exists order_type text;

create or replace function public.orders_set_order_type() returns trigger
language plpgsql as $$
begin
  if new.raw is not null and jsonb_typeof(new.raw) = 'object' and new.raw ? 'order_type' then
    new.order_type := nullif(new.raw->>'order_type', '');
  end if;
  return new;
end $$;

drop trigger if exists orders_order_type on orders;
create trigger orders_order_type before insert or update of raw on orders
  for each row execute function public.orders_set_order_type();

update orders
   set order_type = nullif(raw->>'order_type', '')
 where raw is not null and jsonb_typeof(raw) = 'object' and raw ? 'order_type';

-- ===== supabase/migrations/0005_presenter_tier.sql =====
-- Presenter commission tier: each sold item pays max($ per item, X% of the show's average item price).
-- Default X = 10%: $1/item up to a $10 average, $1.20 at $12, $1.50 at $15.

alter table cost_profiles
  add column if not exists presenter_pct_of_avg numeric(8,6) not null default 0.10
  check (presenter_pct_of_avg >= 0 and presenter_pct_of_avg < 1);

-- Apply the rule to shows tracked with the current (v2) cost model, and to their presenter shifts.
update live_shows
   set cost_snapshot = jsonb_set(cost_snapshot, '{presenter,pctOfAvgPrice}', '"0.10"')
 where cost_snapshot->>'version' = '2'
   and cost_snapshot ? 'presenter'
   and not (cost_snapshot->'presenter' ? 'pctOfAvgPrice');

update show_staff
   set comp = comp || '{"pctOfAvgPrice":"0.10"}'::jsonb
 where role = 'host'
   and comp is not null
   and not (comp ? 'pctOfAvgPrice');

-- ===== supabase/migrations/0006_creator_opportunities.sql =====
-- Creator Opportunities: buyers of a show are looked up on TikTok (follower
-- count only) and buyers with a large following are kept as collaboration
-- leads. Additive only: no existing table or column changes behaviour.

-- Settings ------------------------------------------------------------------
alter table app_settings
  add column if not exists creator_scan_enabled boolean not null default true,
  add column if not exists creator_min_followers integer not null default 15000,
  add column if not exists creator_cache_days integer not null default 30,
  add column if not exists apify_actor text not null default 'xmolodtsov/tiktok-profile-scraper',
  add column if not exists apify_price_per_result numeric(10,5) not null default 0.00075,
  add column if not exists apify_monthly_limit_usd numeric(10,2) not null default 20,
  -- jobs estimated above this wait for approval on the Creator Opportunities page
  add column if not exists creator_approval_over_usd numeric(10,2) not null default 1.00,
  add column if not exists creator_message_template text not null default
    'Hi {name}! Thank you so much for shopping our Jewelar LIVE 💛 We love your content and would love to send you a few pieces to try. Would you be open to a collab?',
  -- prevents two scan workers from running at once (expires so a crash never blocks forever)
  add column if not exists creator_scan_lock_until timestamptz;

-- 30-day follower cache: one row per TikTok username ---------------------------
create table if not exists tiktok_profiles (
  username text primary key,                 -- normalized: lowercase, no "@"
  lookup text not null default 'found' check (lookup in ('found', 'not_found', 'failed')),
  followers bigint,                          -- null = unknown, never 0 for a failed lookup
  nickname text,
  tiktok_user_id text,
  verified boolean,
  private_account boolean,
  avatar_url text,
  bio_link text,
  error text,
  scanned_at timestamptz not null default now(),
  scan_count integer not null default 1
);

-- Buyers of each show, by username (filled when the show is scanned) -----------
create table if not exists show_buyers (
  show_id uuid not null references live_shows (id) on delete cascade,
  username text not null,
  buyer_nickname text,
  customer_id text,                          -- TikTok buyer user_id
  orders integer not null default 0,
  primary key (show_id, username)
);
create index if not exists show_buyers_username on show_buyers (username);

-- Permanent opportunities list: never deleted automatically -------------------
create table if not exists creator_opportunities (
  username text primary key,
  buyer_nickname text,
  customer_id text,
  -- 'name_match': the profile's display name equals the buyer's nickname too.
  -- 'handle_only': found @username but the display name differs — check before contacting.
  match text not null default 'handle_only' check (match in ('name_match', 'handle_only')),
  first_show_id uuid references live_shows (id) on delete set null,
  last_show_id uuid references live_shows (id) on delete set null,
  followers_at_flag bigint,
  status text not null default 'not_contacted' check (status in
    ('not_contacted', 'contacted', 'interested', 'agreed', 'video_posted', 'not_interested')),
  notes text,
  contacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Scan jobs + Apify cost tracking ----------------------------------------------
create table if not exists creator_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('show', 'retry', 'rescan', 'test')),
  show_id uuid references live_shows (id) on delete cascade,
  status text not null default 'queued' check (status in
    ('queued', 'needs_approval', 'running', 'done', 'failed', 'paused_budget', 'cancelled')),
  usernames text[] not null default '{}',    -- what will be / was sent to Apify
  buyers integer not null default 0,
  cached integer not null default 0,
  no_handle integer not null default 0,
  found integer not null default 0,
  not_found integer not null default 0,
  failed integer not null default 0,
  flagged integer not null default 0,
  estimated_cost_usd numeric(10,4) not null default 0,
  actual_cost_usd numeric(10,4),             -- as reported by Apify; null until known
  apify_run_ids text[] not null default '{}',
  approved_by uuid,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- one automatic scan per show, so re-ending or re-running never double-charges
create unique index if not exists creator_scan_jobs_one_per_show on creator_scan_jobs (show_id) where kind = 'show';
create index if not exists creator_scan_jobs_recent on creator_scan_jobs (created_at desc);

-- RLS: members read; collaboration fields are written through server actions.
do $$
declare t text;
begin
  foreach t in array array['tiktok_profiles', 'show_buyers', 'creator_opportunities', 'creator_scan_jobs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (public.is_member())', t || '_read', t);
  end loop;
end $$;

-- App-wide notifications (not tied to one show) are already allowed: show_id is nullable.

-- ===== supabase/migrations/0007_order_buyer_usernames.sql =====
-- Buyer @usernames from the TikTok Seller Center order export (the API only sends
-- the display nickname). Only the order id and username are kept — no names,
-- phones or addresses from the file. Additive only.
create table if not exists order_buyer_usernames (
  external_order_id text primary key,   -- TikTok order id, same as orders.external_order_id
  username text not null,                -- normalized: lowercase, no "@"
  imported_at timestamptz not null default now()
);
create index if not exists order_buyer_usernames_username on order_buyer_usernames (username);

alter table order_buyer_usernames enable row level security;
drop policy if exists order_buyer_usernames_read on order_buyer_usernames;
create policy order_buyer_usernames_read on order_buyer_usernames for select to authenticated using (public.is_member());

-- Which buyers came from the export (exact) vs. a nickname guess.
alter table show_buyers add column if not exists username_source text not null default 'nickname'
  check (username_source in ('export', 'nickname'));

-- ===== supabase/migrations/0008_scan_reports.sql =====
-- End-of-show scan reports: the products scanned out after a LIVE with their real
-- cost. One report per show; uploading again replaces it. The show's frozen cost
-- snapshot gets `scanReport` so profit uses the report's total COGS. Additive only.
create table if not exists show_scan_reports (
  show_id uuid primary key references live_shows (id) on delete cascade,
  file_name text not null,
  report_date date,
  show_label text,
  units integer not null,
  total_cogs numeric(12,2) not null,
  lines jsonb not null,          -- [{brand, product, upc, lots, count, cogs}]
  warnings jsonb not null default '[]'::jsonb,
  uploaded_by uuid,
  uploaded_at timestamptz not null default now()
);

alter table show_scan_reports enable row level security;
drop policy if exists show_scan_reports_read on show_scan_reports;
create policy show_scan_reports_read on show_scan_reports for select to authenticated using (public.is_member());
