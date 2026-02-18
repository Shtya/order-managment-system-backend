// backend/src/shipping/shipping.seed.ts
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ShippingCompanyEntity } from "src/shipping/shipping.entity";

// backend/src/shipping/shipping.defaults.ts
export const DEFAULT_SHIPPING_COMPANIES = [
  {
    code: "bosta",
    name: "Bosta",
    logo: "/integrate/bosta.png",
    website: "bosta.co",
    bg: "linear-gradient(300.09deg, #FAFAFA 74.95%, #B5CBE9 129.29%)",
    description: "integrated.description",
    isActive: true,
  },
  {
    code: "jt",
    name: "J&T Express",
    logo: "/integrate/5.png",
    website: "jtexpress.com",
    bg: "linear-gradient(300.09deg, #FAFAFA 74.95%, #B5CBE9 129.29%)",
    description: "integrated.description",
    isActive: true,
  },
  {
    code: "turbo",
    name: "Turbo",
    logo: "/integrate/4.png",
    website: "turbo.com",
    bg: "linear-gradient(300.09deg, #FAFAFA 74.95%, #CCB5E9 129.29%)",
    description: "integrated.description",
    isActive: true,
  },
] as const;


@Injectable()
export class ShippingSeedService implements OnModuleInit {
  private readonly logger = new Logger(ShippingSeedService.name);

  constructor(
    @InjectRepository(ShippingCompanyEntity)
    private companiesRepo: Repository<ShippingCompanyEntity>,
  ) {}

  async onModuleInit() {
    // ✅ Runs once when module initializes
    await this.seedCompaniesOnce();
  }

  private async seedCompaniesOnce() {
    for (const def of DEFAULT_SHIPPING_COMPANIES) {
      const existing = await this.companiesRepo.findOne({ where: { code: def.code } });

      if (!existing) {
        await this.companiesRepo.save(this.companiesRepo.create(def as any));
        this.logger.log(`Seeded shipping company: ${def.code}`);
      } else {
        // ✅ keep updated if defaults change
        existing.name = def.name;
        existing.logo = def.logo;
        existing.website = def.website;
        existing.bg = def.bg;
        existing.description = def.description;
        existing.isActive = def.isActive;
        await this.companiesRepo.save(existing);
        this.logger.log(`Updated shipping company: ${def.code}`);
      }
    }
  }
}