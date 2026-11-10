-- Jewelar LIVE Profit Tracker — demo dataset (optional)
--
-- Run AFTER the migrations, in the Supabase SQL editor, to explore the app
-- before TikTok is connected. Everything here is TEST data:
--   * shows and orders are flagged is_test = true (blue TEST banner; hidden
--     from history/dashboards unless "Show test shows" is on; never mixed with
--     real orders, which can't attach to test shows)
--   * staff and customers are named "(demo)"
-- Remove it any time with the DELETE block at the bottom.

do $$
declare
  snap jsonb := jsonb_build_object(
    'version', 2,
    'defaultProductCost', '2.50',
    'skuCosts', jsonb_build_object('HOOP-GP-30', '2.10', 'CUBAN-GP-5', '3.40', 'TENNIS-BR', '2.90', 'PEARL-STUD', '1.60'),
    'packingPerItem', '0',
    'percentFee', '0.06',
    'fixedFeePerTransaction', '0',
    'presenter', jsonb_build_object('perUnit', '1.00', 'perHour', '0', 'percentOfSales', '0', 'flatPerShow', '0'),
    'assistant', jsonb_build_object('perUnit', '0', 'perHour', '20.00', 'percentOfSales', '0', 'flatPerShow', '0'),
    'hourlyExpenses', jsonb_build_array(jsonb_build_object('category', 'giveaways', 'label', 'Giveaways / misc.', 'perHour', '30.00')),
    'revenueBasis', 'created',
    'shippingEstimatePerPackage', null
  );
  host_a uuid; host_b uuid; asst uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid;
  t1 timestamptz := date_trunc('hour', now()) - interval '3 days' + interval '20 hours';
  t2 timestamptz := date_trunc('hour', now()) - interval '2 days' + interval '19 hours';
  t3 timestamptz := date_trunc('hour', now()) - interval '1 day' + interval '20 hours';
  comp_host jsonb := '{"perUnit":"1.00","perHour":"0","percentOfSales":"0","flatPerShow":"0"}';
  comp_asst jsonb := '{"perUnit":"0","perHour":"20.00","percentOfSales":"0","flatPerShow":"0"}';
  i int; o uuid; c uuid; v_sku text; v_title text; v_price numeric; qty int; pk uuid; disc numeric;
  skus text[] := array['HOOP-GP-30','CUBAN-GP-5','TENNIS-BR','PEARL-STUD','NAME-NECK','STACK-RING'];
  titles text[] := array['Gold-plated hoop earrings 30mm','Cuban link chain 5mm','CZ tennis bracelet','Freshwater pearl studs','Script name necklace','Stacking ring set'];
  prices numeric[] := array[12, 18, 15, 9, 22, 10];
begin
  -- products & SKU costs (NAME-NECK and STACK-RING deliberately have no cost → fallback $2.50, flagged)
  insert into products (sku, title) select skus[k], titles[k] from generate_subscripts(skus, 1) k on conflict do nothing;
  insert into product_costs (product_id, unit_cost)
  select p.id, v.cost from products p join (values ('HOOP-GP-30', 2.10), ('CUBAN-GP-5', 3.40), ('TENNIS-BR', 2.90), ('PEARL-STUD', 1.60)) v(code, cost) on v.code = p.sku;

  insert into staff (name, role, host_per_item) values ('Sarah (demo)', 'host', 1.00) returning id into host_a;
  insert into staff (name, role, host_per_item, host_per_hour) values ('Dana (demo)', 'host', 1.25, 5) returning id into host_b;
  insert into staff (name, role, hourly_rate) values ('Alex (demo)', 'assistant', 20) returning id into asst;

  -- demo buyers
  for i in 1..12 loop
    insert into customers (platform, external_customer_id, display_name)
    values ('tiktok', 'DEMO-BUYER-' || i, case when i % 3 = 0 then null else 'Demo buyer ' || i end)
    on conflict do nothing;
  end loop;

  -- Show 1: 3-hour evening LIVE, finalized-looking (settled), Sarah + Alex
  insert into live_shows (platform, title, status, detection, live_room_id, started_at, ended_at, times_verified, is_test, cost_snapshot, last_activity_at)
  values ('tiktok', 'Evening Jewelry LIVE (demo)', 'finalized', 'platform', 'DEMO-ROOM-1', t1, t1 + interval '3 hours', true, true, snap, t1 + interval '179 minutes')
  returning id into s1;
  insert into show_staff (show_id, staff_id, role, name, joined_at, comp) values
    (s1, host_a, 'host', 'Sarah (demo)', t1, comp_host),
    (s1, asst, 'assistant', 'Alex (demo)', t1, comp_asst);

  -- Show 2: 90-minute LIVE, host change halfway (Sarah → Dana), awaiting reconciliation
  insert into live_shows (platform, title, status, detection, started_at, ended_at, is_test, cost_snapshot, last_activity_at)
  values ('tiktok', 'Afternoon Gold Drop (demo)', 'awaiting_reconciliation', 'manual', t2, t2 + interval '90 minutes', true, snap, t2 + interval '88 minutes')
  returning id into s2;
  insert into show_staff (show_id, staff_id, role, name, joined_at, left_at, comp) values
    (s2, host_a, 'host', 'Sarah (demo)', t2, t2 + interval '45 minutes', comp_host),
    (s2, host_b, 'host', 'Dana (demo)', t2 + interval '45 minutes', null, '{"perUnit":"1.25","perHour":"5","percentOfSales":"0","flatPerShow":"0"}'),
    (s2, asst, 'assistant', 'Alex (demo)', t2, null, comp_asst);

  -- Show 3: 45-minute slow LIVE (loses money: hourly costs keep running)
  insert into live_shows (platform, title, status, detection, started_at, ended_at, is_test, cost_snapshot, last_activity_at)
  values ('tiktok', 'Late Night Pearls (demo)', 'awaiting_reconciliation', 'manual', t3, t3 + interval '45 minutes', true, snap, t3 + interval '40 minutes')
  returning id into s3;

  -- Show 4: overlaps the start of show 3 (to demonstrate "Needs review")
  insert into live_shows (platform, title, status, detection, started_at, ended_at, is_test, cost_snapshot)
  values ('manual', 'Backup stream (demo)', 'ended', 'manual', t3 - interval '10 minutes', t3 + interval '10 minutes', true, snap)
  returning id into s4;

  -- orders: show 1 → 260, show 2 → 95, show 3 → 9
  for i in 1..364 loop
    declare
      sh uuid; st timestamptz; dur int; n int; k int;
    begin
      if i <= 260 then sh := s1; st := t1; dur := 180; n := 260; k := i;
      elsif i <= 355 then sh := s2; st := t2; dur := 90; n := 95; k := i - 260;
      else sh := s3; st := t3; dur := 45; n := 9; k := i - 355;
      end if;
      v_sku := skus[1 + (i * 7) % 6]; v_title := titles[1 + (i * 7) % 6]; v_price := prices[1 + (i * 7) % 6];
      qty := case when i % 11 = 0 then 2 else 1 end;
      disc := case when i % 9 = 0 then 1.00 else 0 end;
      select id into c from customers where external_customer_id = 'DEMO-BUYER-' || (1 + (i * 5) % 12);
      insert into orders (platform, show_id, external_order_id, status, platform_status, is_test, created_at_platform, received_at,
                          customer_shipping, seller_shipping_cost, actual_platform_fees, settlement_amount, customer_id, live_room_id,
                          attribution, attribution_method, attribution_note, raw)
      values ('tiktok', sh, 'DEMO-' || i,
              case when i in (77, 301) then 'cancelled'::order_status else 'active'::order_status end, 'DEMO', true,
              -- sales cluster in bursts (first 20 min and around the middle of each show)
              st + make_interval(secs => (((k * 997) % (dur * 60))::numeric * case when k % 4 = 0 then 0.3 else 1 end)::int),
              st + make_interval(secs => (((k * 997) % (dur * 60))::numeric * case when k % 4 = 0 then 0.3 else 1 end)::int + 4),
              4.99,
              case when sh = s1 then 6.10 else null end,                                  -- show 1 settled: actual shipping
              case when sh = s1 then round((v_price * qty - disc) * 0.06 + 0.10, 2) else null end,   -- show 1 settled: actual fees
              case when sh = s1 and i not in (77) then round((v_price * qty - disc) - round((v_price * qty - disc) * 0.06 + 0.10, 2) - (6.10 - 4.99), 2) else null end,
              c, case when sh = s1 then 'DEMO-ROOM-1' else null end,
              'assigned', case when sh = s1 then 'platform_live_id' else 'time_window' end, 'Demo data',
              '{"demo": true}')
      returning id into o;
      insert into order_items (order_id, external_item_id, sku, title, quantity, unit_price, seller_discount, product_id)
      values (o, 'DEMO-' || i || '-1', v_sku, v_title, qty, v_price, disc, (select p.id from products p where p.sku = v_sku));
    end;
  end loop;

  -- a refund that arrived two days after show 2 (keeps the commission; adjusts the final view)
  insert into refunds (order_id, external_refund_id, external_item_id, quantity, amount, refunded_at)
  select id, 'DEMO-R-1', external_order_id || '-1', 1, 15.00, t2 + interval '2 days' from orders where external_order_id = 'DEMO-300';

  -- one buyer, three orders, one combined package on show 2 (label paid once)
  insert into packages (platform, external_package_id, status, carrier, tracking_number, label_cost, label_cost_source, reimbursement)
  values ('tiktok', 'DEMO-PKG-1', 'IN_TRANSIT', 'USPS', '9400100000000000000000', 6.40, 'label', 0) returning id into pk;
  insert into package_orders (package_id, order_id)
  select pk, id from orders where external_order_id in ('DEMO-270', 'DEMO-282', 'DEMO-294');

  -- fixed expenses
  insert into show_expenses (show_id, kind, category, description, amount, incurred_at) values
    (s1, 'giveaway', 'giveaways', 'Spin-the-wheel prize (demo)', 25.00, t1 + interval '60 minutes'),
    (s1, 'one_time', 'packaging', 'Gift boxes (demo)', 18.00, t1 + interval '5 minutes'),
    (s2, 'one_time', 'advertising', 'LIVE promo boost (demo)', 40.00, t2 + interval '2 minutes');

  -- an order that falls inside two overlapping show windows → Needs review
  insert into orders (platform, external_order_id, status, is_test, created_at_platform, customer_shipping, attribution, attribution_note, raw)
  values ('tiktok', 'DEMO-REVIEW-1', 'active', true, t3 + interval '5 minutes', 4.99, 'needs_review', 'Order time overlaps 2 show windows', '{"demo": true}')
  returning id into o;
  insert into order_items (order_id, external_item_id, sku, title, quantity, unit_price)
  values (o, 'DEMO-REVIEW-1-1', 'HOOP-GP-30', 'Gold-plated hoop earrings 30mm', 1, 12);
  insert into order_show_attributions (order_id, status, note, candidate_show_ids)
  values (o, 'needs_review', 'Order time overlaps 2 show windows', array[s3, s4]);

  update customers c set
    first_order_at = (select min(created_at_platform) from orders where customer_id = c.id),
    last_order_at = (select max(created_at_platform) from orders where customer_id = c.id)
  where external_customer_id like 'DEMO-BUYER-%';
end $$;

-- To remove all demo data:
-- delete from orders where external_order_id like 'DEMO-%';
-- delete from packages where external_package_id like 'DEMO-%';
-- delete from live_shows where title like '%(demo)';
-- delete from customers where external_customer_id like 'DEMO-BUYER-%';
-- delete from staff where name like '%(demo)';
