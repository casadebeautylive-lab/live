"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { fmtTime } from "@/lib/format";

type N = { id: string; kind?: string; message: string; severity: string; created_at: string; read_at: string | null };

export function Notifications({ showId, timezone }: { showId: string; timezone: string }) {
  const [items, setItems] = useState<N[]>([]);

  useEffect(() => {
    const sb = supabaseBrowser();
    sb.from("notification_events")
      .select("id, kind, message, severity, created_at, read_at")
      .eq("show_id", showId)
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => setItems((data as N[]) ?? []));
    const ch = sb
      .channel(`notif-${showId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notification_events", filter: `show_id=eq.${showId}` }, (p) =>
        setItems((prev) => [p.new as N, ...prev].slice(0, 5)),
      )
      .subscribe();
    return () => {
      sb.removeChannel(ch);
    };
  }, [showId]);

  async function dismiss(id: string) {
    setItems((prev) => prev.filter((n) => n.id !== id));
    await supabaseBrowser().from("notification_events").update({ read_at: new Date().toISOString() }).eq("id", id);
  }

  if (!items.length) return null;
  return (
    <div className="mb-4 space-y-2">
      {items.map((n) => (
        <div
          key={n.id}
          className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm ${
            n.severity === "critical" ? "border-neg/40 bg-neg/10 text-neg" : n.severity === "warning" ? "border-warn/40 bg-warn/10 text-warn" : "border-info/40 bg-info/10 text-info"
          }`}
        >
          <span className="num text-xs opacity-70">{fmtTime(n.created_at, timezone)}</span>
          <span className="flex-1">
            {n.message}
            {n.kind?.startsWith("creator_") && (
              <Link href="/creators" className="ml-2 font-semibold underline">
                Open Creator Opportunities
              </Link>
            )}
          </span>
          <button onClick={() => dismiss(n.id)} className="text-xs opacity-70 hover:opacity-100" aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
