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
