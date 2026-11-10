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
