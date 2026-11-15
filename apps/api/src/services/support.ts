import crypto from "node:crypto";
import {
  NotificationType,
  PrismaClient,
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
  UserRole,
} from "@prisma/client";

export class SupportError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SupportError";
  }
}

export class SupportService {
  constructor(private readonly prisma: PrismaClient) {}

  async createTicket(input: {
    actorUserId: string;
    actorRole: UserRole;
    customerId: string;
    partnerId?: string | null;
    orderId?: string | null;
    category: SupportTicketCategory;
    priority?: SupportTicketPriority;
    subject: string;
    body: string;
    ipAddress?: string;
  }) {
    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}-${crypto
      .randomBytes(2)
      .toString("hex")
      .toUpperCase()}`;

    return this.prisma.$transaction(async (tx) => {
      if (input.orderId) {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          select: { id: true, customerId: true },
        });
        if (!order || order.customerId !== input.customerId) {
          throw new SupportError(
            403,
            "ORDER_CUSTOMER_MISMATCH",
            "Order does not belong to this customer."
          );
        }
      }

      const ticket = await tx.supportTicket.create({
        data: {
          ticketNumber,
          customerId: input.customerId,
          partnerId: input.partnerId ?? null,
          orderId: input.orderId ?? null,
          category: input.category,
          status: SupportTicketStatus.OPEN,
          priority: input.priority ?? SupportTicketPriority.MEDIUM,
          subject: input.subject.trim(),
          messages: {
            create: {
              authorUserId: input.actorUserId,
              isInternal: false,
              body: input.body.trim(),
            },
          },
        },
        include: {
          messages: {
            where: { isInternal: false },
            orderBy: { createdAt: "asc" },
          },
        },
      });

      const staff = await tx.user.findMany({
        where: {
          role: { in: [UserRole.OWNER, UserRole.OPS_ADMIN] },
          isActive: true,
        },
        select: { id: true },
      });
      if (staff.length > 0) {
        const notifType =
          input.category === SupportTicketCategory.ORDER_DISPUTE
            ? NotificationType.DISPUTE_OPENED
            : NotificationType.SUPPORT_TICKET_CREATED;
        await tx.notification.createMany({
          data: staff.map((s) => ({
            recipientUserId: s.id,
            type: notifType,
            orderId: input.orderId ?? null,
            title: `${input.category === SupportTicketCategory.ORDER_DISPUTE ? "Dispute" : "Support"} ${ticket.ticketNumber}`,
            message: ticket.subject,
          })),
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "SUPPORT_TICKET_CREATED",
          targetEntity: "support_tickets",
          targetId: ticket.id,
          afterState: {
            ticketNumber: ticket.ticketNumber,
            category: ticket.category,
            orderId: ticket.orderId,
          },
          ipAddress: input.ipAddress,
        },
      });

      return ticket;
    }, { timeout: 20000, maxWait: 10000 });
  }

  async listCustomerTickets(customerId: string) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      include: {
        order: { select: { id: true, orderNumber: true, status: true } },
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            body: true,
            createdAt: true,
            author: { select: { id: true, role: true } },
          },
        },
      },
    });
    return tickets.map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      category: t.category,
      status: t.status,
      priority: t.priority,
      subject: t.subject,
      order: t.order,
      resolutionSummary: t.resolutionSummary,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      messages: t.messages.map((m) => ({
        id: m.id,
        body: m.body,
        authorRole: m.author.role,
        createdAt: m.createdAt.toISOString(),
      })),
    }));
  }

  async listPartnerTickets(partnerId: string) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: {
        OR: [{ partnerId }, { customer: { attributedPartnerId: partnerId } }],
      },
      orderBy: { updatedAt: "desc" },
      include: {
        customer: { select: { id: true, fullName: true } },
        order: { select: { id: true, orderNumber: true, status: true } },
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            body: true,
            createdAt: true,
            author: { select: { id: true, role: true } },
          },
        },
      },
    });
    return tickets.map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      category: t.category,
      status: t.status,
      priority: t.priority,
      subject: t.subject,
      customer: t.customer,
      order: t.order,
      resolutionSummary: t.resolutionSummary,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      messages: t.messages.map((m) => ({
        id: m.id,
        body: m.body,
        authorRole: m.author.role,
        createdAt: m.createdAt.toISOString(),
      })),
    }));
  }

  async listStaffTickets(filters?: {
    status?: SupportTicketStatus;
    category?: SupportTicketCategory;
    priority?: SupportTicketPriority;
  }) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: {
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.category ? { category: filters.category } : {}),
        ...(filters?.priority ? { priority: filters.priority } : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
      include: {
        customer: { select: { id: true, fullName: true, email: true } },
        partner: { select: { id: true, displayName: true, referralCode: true } },
        order: { select: { id: true, orderNumber: true, status: true } },
        assignedTo: { select: { id: true, email: true, role: true } },
        messages: {
          orderBy: { createdAt: "asc" },
          include: { author: { select: { id: true, email: true, role: true } } },
        },
      },
    });
    return tickets.map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      category: t.category,
      status: t.status,
      priority: t.priority,
      subject: t.subject,
      customer: t.customer,
      partner: t.partner,
      order: t.order,
      assignedTo: t.assignedTo,
      resolutionSummary: t.resolutionSummary,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      messages: t.messages.map((m) => ({
        id: m.id,
        isInternal: m.isInternal,
        body: m.body,
        author: m.author,
        createdAt: m.createdAt.toISOString(),
      })),
    }));
  }

  async getTicketForActor(input: {
    ticketId: string;
    actorRole: UserRole;
    customerId?: string;
    partnerId?: string;
  }) {
    const isStaff = input.actorRole === UserRole.OWNER || input.actorRole === UserRole.OPS_ADMIN;
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: input.ticketId },
      include: {
        customer: {
          select: { id: true, fullName: true, attributedPartnerId: true },
        },
        order: { select: { id: true, orderNumber: true, status: true } },
        messages: {
          ...(isStaff ? {} : { where: { isInternal: false } }),
          orderBy: { createdAt: "asc" },
          include: {
            author: { select: { id: true, email: isStaff, role: true } },
          },
        },
      },
    });

    if (!ticket) {
      throw new SupportError(404, "TICKET_NOT_FOUND", "Support ticket not found.");
    }

    if (input.actorRole === UserRole.CUSTOMER && ticket.customerId !== input.customerId) {
      throw new SupportError(403, "FORBIDDEN", "Forbidden: ticket belongs to another customer.");
    }
    if (
      input.actorRole === UserRole.PARTNER &&
      ticket.partnerId !== input.partnerId &&
      ticket.customer.attributedPartnerId !== input.partnerId
    ) {
      throw new SupportError(
        403,
        "FORBIDDEN",
        "Forbidden: ticket is not attributed to your partner account."
      );
    }

    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority,
      subject: ticket.subject,
      customer: { id: ticket.customer.id, fullName: ticket.customer.fullName },
      order: ticket.order,
      resolutionSummary: ticket.resolutionSummary,
      resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
      createdAt: ticket.createdAt.toISOString(),
      messages: ticket.messages.map((m) => ({
        id: m.id,
        ...(isStaff ? { isInternal: m.isInternal } : {}),
        body: m.body,
        authorRole: m.author.role,
        ...(isStaff ? { authorEmail: m.author.email } : {}),
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async addMessage(input: {
    ticketId: string;
    actorUserId: string;
    actorRole: UserRole;
    customerId?: string;
    partnerId?: string;
    body: string;
    isInternal: boolean;
    ipAddress?: string;
  }) {
    const isStaff = input.actorRole === UserRole.OWNER || input.actorRole === UserRole.OPS_ADMIN;
    if (input.isInternal && !isStaff) {
      throw new SupportError(
        403,
        "FORBIDDEN_INTERNAL_NOTE",
        "Only Owner or OpsAdmin can post internal staff notes."
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({
        where: { id: input.ticketId },
        include: {
          customer: { select: { id: true, userId: true, attributedPartnerId: true } },
        },
      });
      if (!ticket) {
        throw new SupportError(404, "TICKET_NOT_FOUND", "Support ticket not found.");
      }

      if (input.actorRole === UserRole.CUSTOMER && ticket.customerId !== input.customerId) {
        throw new SupportError(403, "FORBIDDEN", "Forbidden: ticket belongs to another customer.");
      }
      if (
        input.actorRole === UserRole.PARTNER &&
        ticket.partnerId !== input.partnerId &&
        ticket.customer.attributedPartnerId !== input.partnerId
      ) {
        throw new SupportError(
          403,
          "FORBIDDEN",
          "Forbidden: ticket is not attributed to your partner account."
        );
      }

      const msg = await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorUserId: input.actorUserId,
          isInternal: input.isInternal,
          body: input.body.trim(),
        },
      });

      if (isStaff && !input.isInternal && ticket.customer.userId) {
        await tx.notification.create({
          data: {
            recipientUserId: ticket.customer.userId,
            type: NotificationType.SUPPORT_TICKET_UPDATED,
            orderId: ticket.orderId,
            title: `Update on ${ticket.ticketNumber}`,
            message: "Support staff posted a reply to your ticket.",
          },
        });
      }

      if (input.isInternal) {
        await tx.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            actionType: "SUPPORT_INTERNAL_NOTE_ADDED",
            targetEntity: "support_tickets",
            targetId: ticket.id,
            afterState: { messageId: msg.id },
            ipAddress: input.ipAddress,
          },
        });
      }

      return {
        id: msg.id,
        isInternal: msg.isInternal,
        body: msg.body,
        createdAt: msg.createdAt.toISOString(),
      };
    }, { timeout: 20000, maxWait: 10000 });
  }

  async updateTicketStatus(input: {
    ticketId: string;
    actorUserId: string;
    status: SupportTicketStatus;
    assignedToUserId?: string | null;
    resolutionSummary?: string;
    ipAddress?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({
        where: { id: input.ticketId },
        include: { customer: { select: { userId: true } } },
      });
      if (!ticket) {
        throw new SupportError(404, "TICKET_NOT_FOUND", "Support ticket not found.");
      }

      if (
        (input.status === SupportTicketStatus.RESOLVED ||
          input.status === SupportTicketStatus.CLOSED) &&
        (!input.resolutionSummary || input.resolutionSummary.trim().length < 3)
      ) {
        throw new SupportError(
          400,
          "RESOLUTION_SUMMARY_REQUIRED",
          "A resolution summary is required when resolving or closing a ticket."
        );
      }

      const isTerminal =
        input.status === SupportTicketStatus.RESOLVED ||
        input.status === SupportTicketStatus.CLOSED;

      const updated = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: input.status,
          ...(input.assignedToUserId !== undefined
            ? { assignedToUserId: input.assignedToUserId }
            : {}),
          ...(input.resolutionSummary !== undefined
            ? { resolutionSummary: input.resolutionSummary.trim() }
            : {}),
          ...(isTerminal
            ? { resolvedByUserId: input.actorUserId, resolvedAt: new Date() }
            : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actionType: "SUPPORT_TICKET_STATUS_UPDATED",
          targetEntity: "support_tickets",
          targetId: ticket.id,
          beforeState: { status: ticket.status },
          afterState: {
            status: updated.status,
            resolutionSummary: updated.resolutionSummary,
          },
          reason: input.resolutionSummary ?? `Status -> ${input.status}`,
          ipAddress: input.ipAddress,
        },
      });

      if (ticket.customer.userId) {
        await tx.notification.create({
          data: {
            recipientUserId: ticket.customer.userId,
            type: NotificationType.SUPPORT_TICKET_UPDATED,
            orderId: ticket.orderId,
            title: `Ticket ${ticket.ticketNumber} is now ${input.status}`,
            message: updated.resolutionSummary ?? `Status updated to ${input.status}.`,
          },
        });
      }

      return updated;
    }, { timeout: 20000, maxWait: 10000 });
  }
}
