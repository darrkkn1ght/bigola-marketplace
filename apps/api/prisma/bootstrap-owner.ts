import { PrismaClient, UserRole } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto.js";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.OWNER_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.OWNER_BOOTSTRAP_PASSWORD;

  if (!email || !password) {
    throw new Error("Set OWNER_BOOTSTRAP_EMAIL and OWNER_BOOTSTRAP_PASSWORD in the environment.");
  }

  const existingOwner = await prisma.user.findFirst({ where: { role: UserRole.OWNER } });
  if (existingOwner) {
    console.log(`Owner account already exists (${existingOwner.email}). Skipping bootstrap.`);
    return;
  }

  const passwordHash = await hashPassword(password);
  const owner = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: UserRole.OWNER,
      mfaEnabled: false,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorUserId: owner.id,
      actionType: "OWNER_BOOTSTRAPPED",
      targetEntity: "USER",
      targetId: owner.id,
      afterState: { email: owner.email, role: owner.role, mfaEnabled: false },
      reason: "Initial secure CLI bootstrap for primary supplier bigola2823",
    },
  });

  console.log(`Bootstrapped Owner account (${owner.email}). 2FA setup is mandatory before privileged access.`);
}

main()
  .catch((err) => {
    console.error("Owner bootstrap failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

