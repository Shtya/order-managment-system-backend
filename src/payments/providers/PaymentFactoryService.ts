import { Injectable, BadRequestException } from '@nestjs/common';
import { KashierProvider } from './kashierProvider';
import { PaymentProvider } from 'entities/payments.entity';

@Injectable()
export class PaymentFactoryService {
    constructor(
        private kashierProvider: KashierProvider,
        // Add other providers here (e.g., private stripeProvider: StripeProvider)
    ) { }

    getProviderByCurrency(currency: string): PaymentProvider {
        const formattedCurrency = currency.toUpperCase();

        switch (formattedCurrency) {
            case 'EGP':
                return this.kashierProvider;
            default:
                throw new BadRequestException(`Provider for ${formattedCurrency} not yet implemented`);
        }
    }
}