import { BadRequestException, Injectable } from "@nestjs/common";
import { KashierProvider } from "./kashierProvider";
import { PaymentProvider } from "../../../entities/payments.entity";
import { TranslationService } from "common/translation.service";

@Injectable()
export class PaymentFactoryService {
    constructor(
        private kashierProvider: KashierProvider,
        private readonly translations: TranslationService,
        // Add other providers here (e.g., private stripeProvider: StripeProvider)
    ) { }

    getProviderByCurrency(currency: string): PaymentProvider {
        const formattedCurrency = currency.toUpperCase();
        
        switch (formattedCurrency) {
            case 'EGP':
                return this.kashierProvider;
            default:
                throw new BadRequestException(this.translations.t('domains.payments.provider_not_yet_implemented', { args: { currency: formattedCurrency } }));
        }
    }
}