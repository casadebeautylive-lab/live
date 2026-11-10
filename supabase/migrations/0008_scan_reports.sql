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
