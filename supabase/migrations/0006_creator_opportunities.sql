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
