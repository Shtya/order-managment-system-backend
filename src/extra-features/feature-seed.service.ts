// backend/src/subscriptions/feature-seed.service.ts
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Feature, FeatureType } from "entities/plans.entity";
import { Repository } from "typeorm";

export const DEFAULT_FEATURES = [
    {
        type: FeatureType.WHATSAPP_CONFIRMATION,
        name: "WhatsApp Confirmation",
        price: 50.00,
        isActive: true,
    },
    {
        type: FeatureType.AI_ANALYTICS,
        name: "AI Analytics",
        price: 150.00,
        isActive: true,
    },
    {
        type: FeatureType.FRAUD_DETECTION,
        name: "Fraud Detection",
        price: 100.00,
        isActive: true,
    },
];

@Injectable()
export class FeatureSeedService implements OnModuleInit {
    private readonly logger = new Logger(FeatureSeedService.name);

    constructor(
        @InjectRepository(Feature)
        private featureRepo: Repository<Feature>,
    ) { }

    async onModuleInit() {
        await this.seedFeatures();
    }

    private async seedFeatures() {
        for (const def of DEFAULT_FEATURES) {
            const existing = await this.featureRepo.findOne({
                where: { type: def.type }
            });

            if (!existing) {
                await this.featureRepo.save(this.featureRepo.create(def));
                this.logger.log(`[SEED] Created new feature: ${def.type}`);
            }
        }
    }
}