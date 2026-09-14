import { Repository } from "typeorm";
import {
  ActionType,
  FlowDefinition,
  FlowWhatsappAccountMode,
  FlowWhatsappSettings,
} from "entities/automation.entity";
import { WhatsappAccountEntity } from "entities/whatsapp.entity";

export const WHATSAPP_FLOW_ACTION_TYPES = new Set<string>([
  ActionType.SEND_WHATSAPP_TEMPLATE,
  ActionType.SEND_WHATSAPP_MESSAGE,
  ActionType.SEND_UPSELL,
  ActionType.AI_ADDRESS_CORRECTION,
]);

export function flowHasWhatsappSteps(flow?: FlowDefinition | null): boolean {
  return !!flow?.nodes?.some((node) =>
    WHATSAPP_FLOW_ACTION_TYPES.has(String(node?.data?.type || "")),
  );
}

export function getFlowWhatsappSettings(
  flow?: FlowDefinition | null,
): Required<Pick<FlowWhatsappSettings, "mode">> &
  Pick<FlowWhatsappSettings, "accountId"> {
  const mode =
    flow?.whatsapp?.mode === FlowWhatsappAccountMode.FIXED
      ? FlowWhatsappAccountMode.FIXED
      : FlowWhatsappAccountMode.RANDOM;
  return {
    mode,
    accountId: flow?.whatsapp?.accountId || null,
  };
}

export function snapshotWhatsappAccount(
  account: WhatsappAccountEntity | null | undefined,
): {
  whatsappAccountId: string | null;
  whatsappAccountName: string | null;
  whatsappAccountPhone: string | null;
} {
  if (!account) {
    return {
      whatsappAccountId: null,
      whatsappAccountName: null,
      whatsappAccountPhone: null,
    };
  }
  return {
    whatsappAccountId: account.id,
    whatsappAccountName: account.name || null,
    whatsappAccountPhone: account.mobileNumber || null,
  };
}

function uniqueWhatsappNumbers(
  accounts: WhatsappAccountEntity[],
): WhatsappAccountEntity[] {
  const seen = new Set<string>();
  const unique: WhatsappAccountEntity[] = [];

  for (const account of accounts) {
    const key = account.phoneNumberId || account.mobileNumber || account.id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(account);
  }

  return unique;
}

function pickRandomAccount(
  accounts: WhatsappAccountEntity[],
): WhatsappAccountEntity | null {
  if (!accounts.length) return null;
  return accounts[Math.floor(Math.random() * accounts.length)];
}

export async function pickWhatsappAccountForRun(
  accountRepo: Repository<WhatsappAccountEntity>,
  adminId: string,
  flow?: FlowDefinition | null,
  existingAccountId?: string | null,
): Promise<WhatsappAccountEntity | null> {
  if (existingAccountId) {
    const existing = await accountRepo.findOne({
      where: { id: existingAccountId },
    });
    if (existing) return existing;
  }

  if (!adminId || !flowHasWhatsappSteps(flow)) return null;

  const settings = getFlowWhatsappSettings(flow);
  if (
    settings.mode === FlowWhatsappAccountMode.FIXED &&
    settings.accountId
  ) {
    return accountRepo.findOne({
      where: { id: settings.accountId, adminId, isActive: true },
    });
  }

  const accounts = await accountRepo.find({
    where: { adminId, isActive: true },
  });
  return pickRandomAccount(uniqueWhatsappNumbers(accounts));
}

export function runWhatsappAccountId(
  run?: { whatsappAccountId?: string | null } | null,
): string | undefined {
  return run?.whatsappAccountId  || undefined;
}
