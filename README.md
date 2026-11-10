# Casa de Beauty LIVE Profit Tracker

Real-time profit for every TikTok Shop LIVE: how much you made or lost, per minute, per hour and per show.
Next.js 15 (App Router, TypeScript) · Tailwind 4 · Supabase (Postgres, Auth, Realtime) · Railway.

---

## Status

| Area | State |
|---|---|
| Profit engine: minute ledger, show totals, estimated vs reconciled, staff shifts, packages | **Built and tested.** 97 automated tests, including every case in spec §17. |
| Database schema, RLS, idempotent ingestion, attribution log, packages | **Built.** Migrations 0001–0003 and the demo seed run against Postgres (PGlite). |
| Pages | **Built; production build passes.** All 13 spec pages: Dashboard, Live, LIVE history (+ compare), show detail (minute by minute), Orders (+ review queue, drilldown), Shipping, Customers, Products & SKU costs (CSV import), Hosts & staff, Expenses, Reports & exports (CSV + print/PDF), Settings, TikTok connection. |
| TikTok OAuth, webhooks, order detail with LIVE `room_id`, refunds, finance, packages, LIVE sessions | **Built, not yet run against TikTok.** Field names come from TikTok's published API reference. Confirm them with your first real order, refund and settlement (see *Verify on first real data*). |
| Whatnot | **Pending access.** There is no official API, and nothing is faked. Shows can still be tracked manually. |

---

## How profit is calculated

Every dollar is placed in one 60-second bucket of the show (the **minute ledger**). Show totals and the minute-by-minute view are sums over the same ledger, so they always agree.

```
Product revenue   = item price × qty − seller-funded discounts − refunds        (before shipping and tax)
Estimated profit  = product revenue
                    − product cost        SKU cost, else the fallback ($2.50) — flagged "estimated"
                    − staff pay           per unit / hourly / % of sales / flat, per person, per shift
                    − hourly expenses     prorated to active LIVE time ($30/h giveaways by default)
                    − fixed expenses      giveaways, ads, packaging, labels, bonuses…
                    − platform fees       TikTok-reported when available, else 6% of product revenue
                    − net shipping        seller charges − customer-paid shipping − subsidies
Reconciled profit = Σ TikTok settled proceeds − product cost − staff pay − expenses
                    (available once every order in the show has settled)
```

**Default costs** (Settings → editable; frozen onto each show when it starts; per-show overrides on the show page):

| | |
|---|---|
| Product cost (fallback) | $2.50 / unit |
| Presenter | $1.00 / unit sold |
| Assistant | $20.00 / hour |
| TikTok commission | 6% of product revenue (no shipping) |
| Giveaways / misc. | $30.00 / hour |

The §4 example is an automated test: 100 units × $10 in 60 minutes gives **$540 profit, $9/min, $540/h, 54%**. Adding $50 of seller shipping gives $490.

**Rules that keep the numbers honest**

- **Hourly costs accrue every active second.** A quiet minute loses money ($0.8333/min on defaults). Pausing stops the clock.
- **Customer shipping is never revenue.** Until TikTok settles an order, it can offset the label down to $0 but never turns shipping into profit. A combined package's label is counted once and split across its orders. TikTok's settled per-order figure replaces any estimate, so nothing is deducted twice.
- **Refunds and cancellations:**
  - Refunds reduce revenue and the fee estimate in the original order's minute.
  - Commission already earned and the product cost are kept.
  - Cancelled orders drop out of every total.
- **Late changes keep the live picture.** Late orders, refunds and settlements update the show they belong to. The original live estimate is saved when the show ends (`show_minute_metrics`), and the show page shows *live estimate vs now* with each adjustment.
- **Cost history is preserved.** Each show keeps the cost snapshot it started with, and each shift keeps the pay rates in force when the person was assigned. Old reports never change unless the owner recalculates a show.
- **Money is decimal throughout:** decimal.js in the app, `numeric` in Postgres. Timestamps are stored in UTC and displayed in the reporting time zone (America/New_York).

## How orders find their LIVE (automatic detection)

TikTok's Get Order Detail (version 202507) returns `line_items[].room_id`, the LIVE session the item was bought in.

1. **Known room id** → the order goes to that show.
2. **New room id** → it links to the show you started manually, if one is running. Otherwise a show is **created automatically**. An auto-detected show closes after 20 quiet minutes (configurable).
3. **Next day:** TikTok's LIVE analytics (`/analytics/202609/shop_lives/performance`) confirm the exact start, end and title. Hourly costs are then recalculated on the real duration.
4. **No LIVE information on the order** → it matches by show time window, but only if exactly one window fits. Two overlapping windows → **Needs review**.
5. **TikTok says the order wasn't placed in a LIVE, but it falls inside a show** → **Needs review**, never auto-assigned.
6. **Historical imports without a room id** stay unassigned.

Every decision, automatic or manual, is logged in `order_show_attributions`. Manual changes are also written to `audit_logs`.

---

## Setup

### 1. Supabase

1. Create a project (US East is closest to Miami).
2. **SQL Editor** → run, in order: `supabase/migrations/0001_init.sql`, `0002_ingest_function.sql`, `0003_profit_tracker.sql`.
   - Already running the earlier version? Run only `0003`. It is additive: existing shows keep calculating exactly as before, and cost profiles still on the old defaults move to the new ones.
3. **Authentication → Users → Add user** (email + password). The first user becomes **owner**.
4. **Authentication → Providers → Email** → turn off *Allow new users to sign up*. Add teammates the same way; they start as *viewer*. To promote someone:
   `update users set role_id = 'admin' where email = '…';`
5. *Optional:* run `supabase/seed_demo.sql` to explore with demo data. It creates 3 test shows (≈365 orders) with a mid-show host change, a refund, a cancellation, a combined package, expenses and one order in review. Everything is flagged TEST, and the file ends with the delete statements to remove it.

### 2. Environment variables

Copy `.env.example` to `.env.local` for local work, and add the same keys in Railway → Variables.

| Variable | Where it comes from | In the browser? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API | Yes (safe; RLS enforced) |
| `SUPABASE_SERVICE_ROLE_KEY` | same | **No** |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` | **No**. Encrypts TikTok tokens (AES-256-GCM). |
| `APP_URL` | `https://<your-app-domain>` | No |
| `CRON_SECRET` | `openssl rand -hex 24` | **No** |
| `APIFY_TOKEN` | Apify → Settings → API & Integrations | **No** |
| `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_AUTHORIZE_URL` | TikTok Shop Partner Center | **No** |
| `TEST_WEBHOOK_SECRET` | any random string (dev only) | No |

### 3. Run locally

```bash
npm install
npm test        # 97 tests
npm run dev     # http://localhost:3000
```

### 4. Deploy on Railway 

1. **Railway → New Project → Deploy from GitHub repo** → `casadebeautylive-lab/live-`. Railway detects Next.js and uses `npm run build` / `npm start`.
2. **Variables:** add everything from step 2.
3. **Settings → Networking → Custom Domain:** your domain (or Railway's free *.up.railway.app domain). At your DNS provider for that domain, add the CNAME Railway shows you. HTTPS is issued automatically.
4. **Supabase → Authentication → URL Configuration:** Site URL `https://<your-app-domain>`.
5. **Scheduler:** add a Railway *Cron* service (or any external scheduler) that calls the sync jobs:

   | Schedule | Command |
   |---|---|
   | `*/5 * * * *` | `curl -fsS -H "Authorization: Bearer $CRON_SECRET" "https://<your-app-domain>/api/cron/sync?job=live"` |
   | `7 * * * *` | `curl -fsS -H "Authorization: Bearer $CRON_SECRET" "https://<your-app-domain>/api/cron/sync?job=finance"` |
   | `15 9 * * *` | `curl -fsS -H "Authorization: Bearer $CRON_SECRET" "https://<your-app-domain>/api/cron/sync?job=daily"` |

   What each job does:
   - **`live`:** closes idle auto-detected LIVEs and re-imports the last 2 hours of orders, in case a webhook was missed.
   - **`finance`:** TikTok fees, shipping and settlements; packages; marks fully settled shows *Finalized*.
   - **`daily`:** official LIVE start/end/title.

   The same jobs can be run by hand on **TikTok connection**.
6. **Backups:** Supabase → Database → Backups (daily on paid plans; enable PITR if you want point-in-time restore).

### 5. TikTok Shop

1. **Create the app:** Partner Center → create a custom app for your own shop. Request the scopes for Order, Fulfillment/Package, Finance, Return & Refund and **Data/Analytics (LIVE)**.
2. **Redirect URL:** `https://<your-app-domain>/api/integrations/tiktok/callback`.
3. **Credentials:** put the app key, app secret and seller authorization link into the env vars, then redeploy.
4. **Authorize:** in the app, **TikTok connection → Authorize TikTok Shop**.
5. **Webhooks:** Partner Center → Webhooks → subscribe to `https://<your-app-domain>/api/webhooks/tiktok` for **Order status change**, **Cancellation status change**, **Return status change** and **Package update**. Signatures are verified and duplicate deliveries are ignored.
6. **Backfill:** **TikTok connection → Import orders (last 7 days)**, then **Sync fees & settlements**.

### Verify on first real data

These come from TikTok's published API reference but haven't been run against your shop yet.

- **One real LIVE order:**
  - Its show is created or linked automatically, and *Matched by* says *TikTok LIVE id*.
  - If an order fails to parse, **TikTok connection → Incoming events** shows the error. Raw orders are stored in `orders.raw`, and the field mapping lives in `src/lib/integrations/tiktok/map.ts`. Then **Retry failed**.
- **One refund:** after TikTok completes the return, it appears on the order and reduces the show's revenue.
- **One settled order:** the order page's *TikTok finance* table should match Seller Center (revenue, fees, shipping, settlement). If TikTok's revenue differs from the order lines, the page warns.
- **The next day:** the LIVE's start/end becomes *confirmed by TikTok* on the show page.
- **Partner Center:** check the exact scope names and rate limits.

---

## Pages

| Page | What it shows |
|---|---|
| **Dashboard** `/` | Period, current or last LIVE, host and product filters; profit, reconciled profit, per-show and daily charts; top customers, products and hosts. |
| **Live** `/live` | Active show: the spec's KPI cards, this minute / rolling 5 & 10 min / best & worst minute / best 15 min, charts by minute. Realtime with a 30 s safety refresh; shows last synced and estimated badges. |
| **LIVE history** `/history` | Every show with status and data status; tick several to **compare**. |
| **Show** `/shows/[id]` | Full show record, minute-by-minute table and charts, live estimate vs now, staff shifts and payroll editing, per-show cost rules, expenses, products, orders, CSV and report links. |
| **Shows** `/shows` | Start, schedule or go live; staff join/leave; expenses; test-show simulator. |
| **Orders** `/orders` | Filters, Needs-review queue with one-click assignment, order drilldown (items, refunds, shipping, finance, packages, attribution history). |
| **Shipping** `/shipping` | Seller-paid net shipping per show, per order, per package and per unit; order and package detail with source (settled, label, estimate, pending). |
| **Customers** `/customers` | Rankings by lifetime and period spend, units, orders, best single LIVE, LIVEs bought from, repeat frequency and AOV; customer history. Names TikTok doesn't share show as *Unavailable*. |
| **Products & costs** `/products` | Units, revenue, margin and contribution by SKU; versioned SKU costs; CSV import and export. |
| **Hosts & staff** `/team` | Performance per presenter and assistant (profit/h, profit/min, sales on shift, pay, best show); staff and pay rates (admins). |
| **Expenses** `/expenses` | Fixed and hourly expenses by category; add, edit, delete (audited). |
| **Reports** `/reports` | CSV exports (shows, orders, payroll, products, customers, expenses; minutes per show) and a print/PDF report. |
| **Settings** `/settings` | Default cost rules, hourly expense lines, fee rule, shipping estimate, reporting time zone, accounting basis (created vs paid), attribution windows, alerts. |
| **TikTok connection** `/integrations` | Authorization, sync now, sync job log, incoming webhook events, retry. |

Roles:
- **Owner / admin:** can edit everything (costs, payroll, attribution, expenses). Every financial edit is audited.
- **Viewer:** read-only.
- **Owner only:** recalculating a past show with today's settings.

## End-of-show scan report (real product cost)

After a show, upload the **End of Show Scan Report** (PDF or CSV) on the show's page. The app reads every row (Brand, Product, UPC, Lot(s), Count, Remaining, COGS), saves it in `show_scan_reports`, and stores `scanReport` on the show's cost snapshot. From then on the show's product cost is exactly the report's **Total COGS**: sold items are costed by UPC (matched to the TikTok seller SKU), then scaled so the total equals the report. Without UPC matches the total is spread evenly per unit. Before the upload (and in the "original live estimate" view) product cost uses the default rules. Header totals that don't match the rows, or scanned units that differ from TikTok's, are flagged on the page.

## Creator Opportunities

After a show ends (ended by hand or auto-closed), a background job looks up its buyers on TikTok and keeps buyers with 15K+ followers on **Creator Opportunities**.

- Buyer username: TikTok's API only sends the display nickname, so upload the **Seller Center order export (CSV)** on the page after a LIVE. Its "Buyer Username" column is saved as order id → username (nothing else from the file) and the LIVE is re-scanned. Without an upload, the nickname is used only when it can be a username, and the match is checked by profile photo.
- Lookups use the Apify Actor `xmolodtsov/tiktok-profile-scraper` in profile-only mode (`resultsPerPage: 0`, one $0.00075 result per username, no videos).
- `tiktok_profiles` is a 30-day cache: a username is looked up at most once per 30 days. Failed lookups are stored as Unknown (never 0) and can be retried.
- Cost controls: one job per show (unique index), one worker at a time (DB lock), Apify run caps (`maxItems`, `maxTotalChargeUsd`), jobs estimated over $1 wait for approval, and scans pause at the monthly limit ($20 by default). Actual charges come from Apify's `usageTotalUsd`.
- Shows that ended before the feature are only scanned from the page ("Scan an earlier LIVE").
- Matching: `handle_only` means the order nickname matched a TikTok @username but the display name differs, so check the profile before reaching out. Messages are only copied; nothing is sent automatically.

## Project layout

```
src/lib/engine/            ledger.ts (minute ledger) · profit.ts · minutes.ts · products.ts · velocity.ts · alerts.ts — pure, tested
src/lib/attribution.ts     which show an order belongs to (room id → window → needs review)
src/lib/ingest/            normalized order schema, idempotent ingest + webhook dedupe, Supabase repo
src/lib/integrations/tiktok/  signing, OAuth/client, order + returns mapping, finance/LIVE mapping, sync jobs
src/lib/lifecycle.ts       freeze live estimate at show end, close idle detected LIVEs, finalize settled shows
src/app/(app)/             pages listed above
src/app/api/               webhooks, OAuth, cron sync, CSV exports, snapshot
supabase/migrations/       schema + RLS + ingest_order_v3 + upsert_package
supabase/seed_demo.sql     optional demo dataset (TEST)
tests/                     engine, spec §17, attribution, ingestion, finance/returns mapping, CSV, dates, render
```

## Known limits

- **LIVE timing.** TikTok has no "LIVE started/ended" webhook. A detected show starts at its first order and ends after the quiet period, until TikTok's LIVE analytics confirm the real times about a day later. To count costs from the very first minute, start the show manually on **Shows**; its room id links automatically.
- **Shipping before settlement** is *Pending*, or uses your per-package estimate if you set one in Settings. TikTok's label price at label creation is itself only an estimate, so the actual cost comes from Finance.
- **Alerts** are evaluated by an open dashboard. Email/push delivery is not wired; `notification_events` is the hook for it.
- **Charts** use the app's own lightweight SVG charts rather than Recharts. They're interactive (hover/tap) and handle losses below zero without adding a dependency.
