import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PrismaClient, UserRole } from "@prisma/client";
import { normalizeEmail } from "@bigola/shared";
import { hashPassword } from "../lib/crypto.js";

async function main() {
  const prisma = new PrismaClient();
  try {
    const existingOwner = await prisma.user.findFirst({
      where: { role: UserRole.OWNER },
      select: { id: true, email: true },
    });

    if (existingOwner) {
      console.error("Refusing bootstrap: an OWNER account already exists.");
      process.exitCode = 1;
      return;
    }

    let email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim() ?? "";
    let password = process.env.BOOTSTRAP_OWNER_PASSWORD ?? "";

    if (!email || !password) {
      const rl = readline.createInterface({ input, output });
      try {
        if (!email) {
          email = (await rl.question("Owner Email (Big Ola): ")).trim();
        }
        if (!password) {
          password = await rl.question("Owner Password (min 12 chars): ");
        }
      } finally {
        rl.close();
      }
    }

    const normalizedEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      console.error("Invalid email address.");
      process.exitCode = 1;
      return;
    }
    if (password.length < 12) {
      console.error("Password must be at least 12 characters long.");
      process.exitCode = 1;
      return;
    }

    const passwordHash = await hashPassword(password);

    const owner = await prisma.$transaction(async (tx) => {
      const doubleCheck = await tx.user.findFirst({
        where: { role: UserRole.OWNER },
        select: { id: true },
      });
      if (doubleCheck) {
        throw new Error("OWNER_ALREADY_EXISTS");
      }

      const created = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          role: UserRole.OWNER,
          mfaEnabled: false,
          isActive: true,
        },
        select: { id: true, email: true, role: true },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: created.id,
          actionType: "OWNER_BOOTSTRAPPED",
          targetEntity: "USER",
          targetId: created.id,
          afterState: { email: created.email, role: created.role },
          reason: "Initial one-time Owner bootstrap via CLI",
        },
      });

      return created;
    });

    console.log(`Owner account created for ${owner.email} (id: ${owner.id}).`);
    console.log("Next step: Sign in at /login and complete mandatory 2FA enrollment.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  if (err instanceof Error && err.message === "OWNER_ALREADY_EXISTS") {
    console.error("Refusing bootstrap: an OWNER account already exists.");
  } else {
    console.error("Owner bootstrap failed:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
