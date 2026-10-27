import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSession();
  redirect(`/dashboard/${session.role}`);
}
