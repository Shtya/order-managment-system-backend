import { Injectable } from '@nestjs/common';

interface MaskedPair {
	token: string;
	original: string;
}

/**
 * Best-effort PII masking for phone numbers, emails, and long digit runs
 * before content is sent to an external LLM provider. `unmask` restores
 * exact tokens when they survive the provider round-trip.
 */
@Injectable()
export class AiPiiMaskerService {
	private readonly phonePattern = /(\+?20[012]\d{9}|01[0125]\d{8})/g;
	private readonly emailPattern = /[\w.+-]+@[\w-]+\.[\w.]+/g;
	private readonly longDigitsPattern = /\b\d{9,16}\b/g;

	mask(text: string): { text: string; pairs: MaskedPair[] } {
		const pairs: MaskedPair[] = [];
		let index = 0;

		const replace = (match: string): string => {
			index += 1;
			const token = `[PII_${index}]`;
			pairs.push({ token, original: match });
			return token;
		};

		let masked = text
			.replace(this.phonePattern, replace)
			.replace(this.emailPattern, replace)
			.replace(this.longDigitsPattern, replace);

		return { text: masked, pairs };
	}

	unmask(text: string, pairs: MaskedPair[]): string {
		let out = text;
		for (const pair of pairs) {
			out = out.split(pair.token).join(pair.original);
		}
		return out;
	}
}
