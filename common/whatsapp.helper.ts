


export function normalizePhone(phone?: string) {
    if (!phone) return "";
    return phone.replace(/[^0-9+]/g, "").slice(0, 20);
}