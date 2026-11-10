"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type L = { href: string; label: string; icon: string };

const I = {
  overview: "M4 13h6V4H4v9zm10 7h6V11h-6v9zM4 20h6v-4H4v4zm10-16v4h6V4h-6z",
  live: "M3 12h4l3-8 4 16 3-8h4",
  history: "M4 6h16M4 12h16M4 18h10",
  orders: "M6 3h12l1 4H5l1-4zm-1 4h14v13H5V7zm4 4h6",
  shipping: "M3 7h11v9H3zM14 10h4l3 3v3h-7zM7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm10 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  customers: "M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3 3 0 100-6 3 3 0 000 6zM21 19v-1a4 4 0 00-3-3.9M16 4.1a3 3 0 010 5.8",
  products: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 9l8-4.5M12 12v9M12 12L4 7.5",
  team: "M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0",
  expenses: "M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.8 5 3.5 5 1.6 5 3.5-2.2 3-5 3-5-1.1-5-3",
  reports: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 00-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 002 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
  connections: "M9 15l6-6M7 11l-2 2a3.5 3.5 0 005 5l2-2m2-6l2-2a3.5 3.5 0 00-5-5l-2 2",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  creators: "M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8-4.3-4.1 5.9-.8L12 3z",
};

const LINKS: L[] = [
  { href: "/", label: "Dashboard", icon: I.overview },
  { href: "/live", label: "Live", icon: I.live },
  { href: "/history", label: "LIVE history", icon: I.history },
  { href: "/orders", label: "Orders", icon: I.orders },
  { href: "/shipping", label: "Shipping", icon: I.shipping },
  { href: "/customers", label: "Customers", icon: I.customers },
  { href: "/creators", label: "Creator Opportunities", icon: I.creators },
  { href: "/products", label: "Products & costs", icon: I.products },
  { href: "/team", label: "Hosts & staff", icon: I.team },
  { href: "/expenses", label: "Expenses", icon: I.expenses },
  { href: "/reports", label: "Reports", icon: I.reports },
  { href: "/settings", label: "Settings", icon: I.settings },
  { href: "/integrations", label: "TikTok connection", icon: I.connections },
];

const MOBILE_MAIN = ["/", "/live", "/history", "/orders"];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function Nav({ email, role, reviewCount = 0, creatorCount = 0 }: { email: string; role: string; reviewCount?: number; creatorCount?: number }) {
  const path = usePathname();
  const [more, setMore] = useState(false);
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));
  const badge = (href: string) =>
    href === "/orders" && reviewCount > 0 ? (
      <span className="num ml-auto rounded-full bg-warn/20 px-1.5 text-[10px] font-semibold text-warn">{reviewCount}</span>
    ) : href === "/creators" && creatorCount > 0 ? (
      <span className="num ml-auto rounded-full bg-gold/20 px-1.5 text-[10px] font-semibold text-gold">{creatorCount}</span>
    ) : null;

  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-panel/60 px-3 py-6 md:flex">
        <div className="mb-6 px-3">
          <div className="font-serif text-lg tracking-[0.18em] text-gold">CASA DE BEAUTY</div>
          <div className="label mt-0.5">LIVE Profit Tracker</div>
        </div>
        <nav className="flex flex-col gap-0.5 overflow-y-auto">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${active(l.href) ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"}`}
            >
              <Icon d={l.icon} />
              {l.label}
              {badge(l.href)}
            </Link>
          ))}
        </nav>
        <div className="mt-auto px-3 pt-4 text-xs text-faint">
          <div className="truncate">{email}</div>
          <div className="mb-3 capitalize">{role}</div>
          <form action="/api/auth/signout" method="post">
            <button className="text-muted hover:text-ink">Sign out</button>
          </form>
        </div>
      </aside>

      {/* mobile: 4 main tabs + More sheet */}
      {more && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] rounded-t-2xl border-t border-line bg-panel p-3" onClick={(e) => e.stopPropagation()}>
            <div className="grid grid-cols-3 gap-2">
              {LINKS.filter((l) => !MOBILE_MAIN.includes(l.href)).map((l) => (
                <Link key={l.href} href={l.href} onClick={() => setMore(false)} className={`flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-center text-[11px] ${active(l.href) ? "bg-panel-2 text-gold" : "text-muted"}`}>
                  <Icon d={l.icon} />
                  {l.label}
                  {l.href === "/creators" && creatorCount > 0 && <span className="num rounded-full bg-gold/20 px-1.5 text-[10px] font-semibold text-gold">{creatorCount} new</span>}
                </Link>
              ))}
            </div>
            <form action="/api/auth/signout" method="post" className="mt-3 border-t border-line pt-3 text-center text-xs">
              <span className="text-faint">{email} · </span>
              <button className="text-muted">Sign out</button>
            </form>
          </div>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-50 flex justify-around border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {LINKS.filter((l) => MOBILE_MAIN.includes(l.href)).map((l) => (
          <Link key={l.href} href={l.href} onClick={() => setMore(false)} className={`relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] ${active(l.href) ? "text-gold" : "text-muted"}`}>
            <Icon d={l.icon} />
            {l.label === "LIVE history" ? "History" : l.label}
            {l.href === "/orders" && reviewCount > 0 && <span className="absolute right-[28%] top-1.5 h-2 w-2 rounded-full bg-warn" />}
          </Link>
        ))}
        <button onClick={() => setMore((m) => !m)} className={`relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] ${more ? "text-gold" : "text-muted"}`}>
          <Icon d={I.more} />
          More
          {creatorCount > 0 && <span className="absolute right-[30%] top-1.5 h-2 w-2 rounded-full bg-gold" />}
        </button>
      </nav>
    </>
  );
}
