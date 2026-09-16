import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { DisparosClient } from "./_components/DisparosClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Disparos" };

export default async function DisparosPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  return <DisparosClient podeEditar={ROLE_RANK[org.role] >= ROLE_RANK.manager} />;
}
