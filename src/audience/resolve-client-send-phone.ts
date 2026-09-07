/** Prefer the client's primary contact number; otherwise the first contact with a phone. */
export function resolveClientSendPhone(client?: {
  primaryContactId?: string | null;
  primaryContact?: { id: string; phoneNumber?: string | null } | null;
  contacts?: Array<{ id: string; phoneNumber?: string | null } | null> | null;
}): { phoneNumber: string | null; customerId: string | null } {
  const trimmed = (value?: string | null) => {
    const s = String(value ?? "").trim();
    return s || null;
  };

  const primary = client?.primaryContact;
  const primaryPhone = trimmed(primary?.phoneNumber);
  if (primaryPhone) {
    return { phoneNumber: primaryPhone, customerId: primary?.id ?? null };
  }

  const contacts = client?.contacts ?? [];
  const first = contacts.find((c) => trimmed(c?.phoneNumber));
  if (first) {
    return {
      phoneNumber: trimmed(first.phoneNumber),
      customerId: first.id ?? null,
    };
  }

  return { phoneNumber: null, customerId: null };
}
