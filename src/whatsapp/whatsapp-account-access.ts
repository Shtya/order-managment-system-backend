import { SystemRole, WhatsappAccessMode } from "entities/user.entity";
import { tenantId } from "src/category/category.service";

export function hasFullWhatsappAccountAccess(me: any): boolean {
  if (
    [SystemRole.ADMIN, SystemRole.SUPER_ADMIN].includes(me?.role?.name)
  ) {
    return true;
  }
  if (me?.whatsappAccessMode === WhatsappAccessMode.ALL) {
    return true;
  }
  const adminId = tenantId(me);
  return Boolean(adminId && me?.id === adminId);
}
