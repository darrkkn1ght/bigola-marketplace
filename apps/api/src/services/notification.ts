import { NotificationType, Prisma, PrismaClient } from "@prisma/client";

export class NotificationService {
  constructor(private readonly prisma: PrismaClient) {}

  async createInTx(
    tx: Prisma.TransactionClient,
    input: {
      recipientUserIds: string[];
      type: NotificationType;
      orderId?: string;
      title: string;
      message: string;
    }
  ) {
    const uniqueIds = Array.from(new Set(input.recipientUserIds));
    if (uniqueIds.length === 0) return;

    await tx.notification.createMany({
      data: uniqueIds.map((recipientUserId) => ({
        recipientUserId,
        type: input.type,
        orderId: input.orderId ?? null,
        title: input.title,
        message: input.message,
      })),
    });
  }

  async listForUser(userId: string, opts?: { limit?: number; unreadOnly?: boolean }) {
    const limit = opts?.limit ?? 50;
    const where = {
      recipientUserId: userId,
      ...(opts?.unreadOnly ? { readAt: null } : {}),
    };
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      this.prisma.notification.count({
        where: { recipientUserId: userId, readAt: null },
      }),
    ]);
    return {
      unreadCount,
      notifications: items.map((n) => ({
        id: n.id,
        type: n.type,
        orderId: n.orderId,
        title: n.title,
        message: n.message,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  async markAllRead(userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { recipientUserId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updatedCount: res.count };
  }

  async markRead(notificationId: string, userId: string) {
    const existing = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!existing || existing.recipientUserId !== userId) {
      return null;
    }
    if (existing.readAt) return existing;
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
  }
}

