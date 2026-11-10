import { supabaseServer } from "@/lib/supabase/clients";
import { csvCell, loadCatalog } from "@/lib/data/products";
import { d } from "@/lib/engine/money";

export const dynamic = "force-dynamic";

/** Current SKU costs as `sku,title,cost` — doubles as the import template. RLS limits this to members. */
export async function GET() {
  const sb = await supabaseServer();
  const { data: auth } = await sb.auth.getClaims();
  if (!auth?.claims?.sub) return new Response("Not signed in", { status: 401 });
  const catalog = await loadCatalog(sb);
  const lines = [...catalog.values()].map((p) => [p.sku, p.title ?? "", p.current ? d(p.current.unitCost).toFixed() : ""].map(csvCell).join(","));
  const body = ["sku,title,cost", ...(lines.length ? lines : ["EXAMPLE-SKU-1,Gold hoop earrings,2.50"])].join("\n") + "\n";
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="sku-costs-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
