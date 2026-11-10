import { redirect } from "next/navigation";
import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { Nav } from "@/components/Nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const [user, review, creators] = await Promise.all([
    currentUser(),
    sb.from("orders").select("id", { count: "exact", head: true }).eq("attribution", "needs_review").eq("is_test", false),
    // unread "new creators found" notifications (cleared when the Creator Opportunities page is opened)
    sb.from("notification_events").select("id", { count: "exact", head: true }).eq("kind", "creator_found").is("read_at", null),
  ]);
  if (!user) redirect("/login");
  return (
    <div className="flex min-h-dvh">
      <Nav email={user.email} role={user.role} reviewCount={review.count ?? 0} creatorCount={creators.count ?? 0} />
      <main className="min-w-0 flex-1 px-4 pb-24 pt-5 md:px-8 md:pb-10 md:pt-8">{children}</main>
    </div>
  );
}
