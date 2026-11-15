export const UserRole = {
  CUSTOMER: "CUSTOMER",
  PARTNER: "PARTNER",
  OPS_ADMIN: "OPS_ADMIN",
  OWNER: "OWNER",
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const Permission = {
  CATALOG_VIEW: "catalog:view",
  ORDER_CREATE_OWN: "order:create_own",
  ORDER_VIEW_OWN: "order:view_own",
  ORDER_VIEW_ALL: "order:view_all",
  ORDER_FULFILMENT_CONFIRM: "order:fulfilment_confirm",
  ORDER_REFUND_MANAGE: "order:refund_manage",
  PAYMENT_PROOF_SUBMIT_OWN: "payment_proof:submit_own",
  PAYMENT_PROOF_VERIFY: "payment_proof:verify",
  PAYMENT_QUEUE_VIEW: "payment:queue_view",
  PARTNER_DASHBOARD_OWN: "partner:dashboard_own",
  PARTNER_OFFLINE_CUSTOMER_REGISTER: "partner:offline_customer_register",
  PARTNER_ORDER_CREATE: "partner:order_create",
  SUPPORT_TICKET_OWN: "support:ticket_own",
  SUPPORT_TICKET_PARTNER: "support:ticket_partner",
  SUPPORT_TICKET_MANAGE: "support:ticket_manage",
  OWNER_DASHBOARD_VIEW: "owner:dashboard_view",
  OWNER_SETTINGS_MANAGE: "owner:settings_manage",
  OWNER_COMMISSION_RULE_CONFIGURE: "owner:commission_rule_configure",
  OWNER_ACCOUNT_TOPOLOGY_MANAGE: "owner:account_topology_manage",
  OWNER_INVENTORY_MANAGE: "owner:inventory_manage",
  OWNER_ATTRIBUTION_OVERRIDE: "owner:attribution_override",
  OWNER_DISBURSEMENT_CONTROL: "owner:disbursement_control",
  OWNER_AUDIT_LOG_READ: "owner:audit_log_read",
  OWNER_PARTNER_MANAGE: "owner:partner_manage",
  OWNER_COMMISSION_VIEW: "owner:commission_view",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  [UserRole.CUSTOMER]: [
    Permission.CATALOG_VIEW,
    Permission.ORDER_CREATE_OWN,
    Permission.ORDER_VIEW_OWN,
    Permission.PAYMENT_PROOF_SUBMIT_OWN,
    Permission.SUPPORT_TICKET_OWN,
  ],
  [UserRole.PARTNER]: [
    Permission.CATALOG_VIEW,
    Permission.PARTNER_DASHBOARD_OWN,
    Permission.PARTNER_OFFLINE_CUSTOMER_REGISTER,
    Permission.PARTNER_ORDER_CREATE,
    Permission.SUPPORT_TICKET_PARTNER,
  ],
  [UserRole.OPS_ADMIN]: [
    Permission.CATALOG_VIEW,
    Permission.ORDER_VIEW_ALL,
    Permission.SUPPORT_TICKET_MANAGE,
    Permission.OWNER_DISBURSEMENT_CONTROL,
  ],
  [UserRole.OWNER]: Object.values(Permission),
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  const allowed = ROLE_PERMISSIONS[role];
  return Boolean(allowed && allowed.includes(permission));
}

export function getPermissionsForRole(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

