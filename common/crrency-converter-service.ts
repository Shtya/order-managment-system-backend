import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class CurrencyConverterService {
    private readonly logger = new Logger(CurrencyConverterService.name);

    private readonly baseUrl = 'https://api.frankfurter.dev/v2';

    /**
     * Generic conversion between any two currencies
     */
    async convert(
        from: string,
        to: string,
        amount: number,
        provider?: string
    ): Promise<{
        from: string;
        to: string;
        amount: number;
        result: number;
        rate: number;
        date: string;
    }> {
        try {
            const url = provider 
                ? `${this.baseUrl}/rate/${from.toUpperCase()}/${to.toUpperCase()}?providers=${provider}`
                : `${this.baseUrl}/rate/${from.toUpperCase()}/${to.toUpperCase()}`;
                
            const { data } = await axios.get(url);

            const rate = data.rate;
            // FIXED: use JS variables, not $amount / $rate
            const result = Math.round(amount * rate * 100) / 100;

            return {
                from: from.toUpperCase(),
                to: to.toUpperCase(),
                amount,
                result,
                rate,
                date: data.date,
            };
        } catch (error: any) {
            this.logger.error('Currency conversion failed', error?.message);
            throw error;
        }
    }
  async convertUsdToEgp(amount: number | string ): Promise<number | null> {
    const {rate: usdToEgp} = await this.convert('USD', 'EGP', 1, "CBE");
        if (!amount || !usdToEgp) return null;

        const amt = parseFloat(amount as string);
        if (isNaN(amt)) return null;

        return Math.round(amt * usdToEgp * 100) / 100;
    }

    async convertEgpToUsd(amount: number | string): Promise<number | null> {
        const {rate: usdToEgp} = await this.convert('USD', 'EGP', 1, "CBE");
        if (!amount || !usdToEgp) return null;

        const amt = parseFloat(amount as string);
        if (isNaN(amt)) return null;

        return Math.round((amt / usdToEgp) * 100) / 100;
    }
}