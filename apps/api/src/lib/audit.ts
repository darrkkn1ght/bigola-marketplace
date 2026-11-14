export interface AuditLogEntryInput {
  actorUserId: string | null;
  actionType: string;
  targetEntity: string;
  targetId?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  reason?: string | null;
  ipAddress?: string | null;
}

export interface AuditLogRecord extends AuditLogEntryInput {
  id: string;
  createdAt: Date;
}

export interface AuditLogStore {
  create(entry: AuditLogEntryInput): Promise<AuditLogRecord>;
  listRecent(limit?: number): Promise<AuditLogRecord[]>;
}

export class AuditLogger {
  constructor(private readonly store: AuditLogStore) {}

  async record(entry: AuditLogEntryInput): Promise<AuditLogRecord> {
    if (!entry.actionType || !entry.targetEntity) {
      throw new Error("Audit log entry requires actionType and targetEntity.");
    }
    return this.store.create({
      ...entry,
      targetId: entry.targetId ?? null,
      beforeState: entry.beforeState ?? null,
      afterState: entry.afterState ?? null,
      reason: entry.reason ?? null,
      ipAddress: entry.ipAddress ?? null,
    });
  }

  async listRecent(limit = 50): Promise<AuditLogRecord[]> {
    return this.store.listRecent(limit);
  }
}

