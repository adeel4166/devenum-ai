import { ActorType, Prisma } from "@prisma/client";
import { prisma } from "./db";

type Tx = Prisma.TransactionClient | typeof prisma;

/** Append-only structured audit log. There is intentionally no update/delete API. */
export async function audit(
  actorType: ActorType,
  actorId: string | number | null,
  action: string,
  target: string | null,
  details: Prisma.InputJsonValue = {},
  tx: Tx = prisma
) {
  const row = await tx.auditEvent.create({
    data: { actorType, actorId: actorId == null ? null : String(actorId), action, target, details },
  });
  console.log(JSON.stringify({ ts: row.createdAt.toISOString(), level: "audit", actorType, actorId, action, target }));
  return row;
}
