import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SystemRole, WhatsappAccessMode } from "entities/user.entity";
import {
  UserWhatsappAccountAccessEntity,
  WhatsappAccountEntity,
} from "entities/whatsapp.entity";
import { tenantId } from "src/category/category.service";
import { Repository } from "typeorm";

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

export async function allowedAccountIds(
  me: any,
  accessRepo: Repository<UserWhatsappAccountAccessEntity>,
): Promise<string[] | null> {
  if (hasFullWhatsappAccountAccess(me)) return null;

  const adminId = tenantId(me);
  const rows = await accessRepo.find({
    where: { adminId, userId: me.id },
    select: { whatsappAccountId: true },
  });

  return rows.map((row) => row.whatsappAccountId);
}

export async function assertWhatsappAccountAccess(options: {
  me: any;
  accountId: string;
  accessRepo: Repository<UserWhatsappAccountAccessEntity>;
  accountRepo: Repository<WhatsappAccountEntity>;
  notFoundMessage: string;
  forbiddenMessage: string;
}): Promise<void> {
  const {
    me,
    accountId,
    accessRepo,
    accountRepo,
    notFoundMessage,
    forbiddenMessage,
  } = options;
  const allowedIds = await allowedAccountIds(me, accessRepo);

  if (!allowedIds || allowedIds.includes(accountId)) return;

  const exists = await accountRepo.exists({
    where: { id: accountId, adminId: tenantId(me) },
  });
  if (!exists) throw new NotFoundException(notFoundMessage);

  throw new ForbiddenException(forbiddenMessage);
}
