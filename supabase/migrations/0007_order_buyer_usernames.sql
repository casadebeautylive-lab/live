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
