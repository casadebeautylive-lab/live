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
