export function normalizeEgyptianPhoneNumber(phoneNumber: string): string {
  const cleaned = phoneNumber.replace(/\D/g, '');

  if (/^(?:20|0)1[0125]\d{8}$/.test(cleaned)) {
    return cleaned.startsWith('0') ? `2${cleaned}` : cleaned;
  }

  return cleaned;
}