export function normalizeEgyptianPhoneNumber(phoneNumber: string): string {
  const cleaned = phoneNumber.replace(/\D/g, '');
  
  if (cleaned.startsWith('010') || cleaned.startsWith('011') || cleaned.startsWith('012') || cleaned.startsWith('015')) {
    return '2' + cleaned;
  }
  
  return cleaned;
}
