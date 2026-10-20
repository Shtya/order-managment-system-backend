import { BadRequestException, Injectable } from "@nestjs/common";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { domainToASCII } from "url";
import { TranslationService } from "common/translation.service";

@Injectable()
export class SmtpSecurityService {
  constructor(private readonly translations: TranslationService) {}

  async resolve(hostInput: string, port: number, security: string) {
    const host = domainToASCII(String(hostInput || "").trim().toLowerCase());
    if (!host || host.length > 253 || isIP(host) || /[^a-z0-9.-]/.test(host))
      this.invalid();
    const allowedPorts = String(process.env.EMAIL_SMTP_ALLOWED_PORTS || "465,587,2525")
      .split(",")
      .map(Number)
      .filter(Number.isInteger);
    if (!allowedPorts.includes(port)) this.invalid();
    if ((port === 465) !== (security === "tls")) this.invalid();
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      this.invalid();
    }
    if (!addresses!.length || addresses!.some(({ address }) => !isPublicIp(address)))
      this.invalid();
    return { host, address: addresses![0].address };
  }

  private invalid(): never {
    throw new BadRequestException(
      this.translations.t("domains.email.smtp_destination_invalid"),
    );
  }
}

function isPublicIp(address: string) {
  if (address.toLowerCase().startsWith("::ffff:"))
    return isPublicIp(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return !(
      value === "::" || value === "::1" || value.startsWith("fc") ||
      value.startsWith("fd") || /^fe[89ab]/.test(value) ||
      value.startsWith("ff") || value.startsWith("2001:db8:")
    );
  }
  return false;
}
