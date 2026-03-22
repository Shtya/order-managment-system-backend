import { ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { UpdateAdminSettingsDto } from "dto/adminSettings.dto";
import { AdminSettingsEntity } from "entities/adminSettings.entity";
import { SystemRole, User } from "entities/user.entity";
import { Repository } from "typeorm";

@Injectable()
export class AdminSettingsService {
  constructor(
    @InjectRepository(AdminSettingsEntity)
    private readonly settingsRepo: Repository<AdminSettingsEntity>,
  ) {}
  private isSuperAdmin(me: User) {
    return me.role?.name === SystemRole.SUPER_ADMIN;
  }
  // Retrieves the global settings or creates a blank one if it's the first run
  async getSettings(): Promise<AdminSettingsEntity> {
    let settings = await this.settingsRepo.findOne({ where: {} }); // Gets the first row

    if (!settings) {
      settings = this.settingsRepo.create({
        email: "",
        whatsapp: "",
        socials: {},
      });
      await this.settingsRepo.save(settings);
    }

    return settings;
  }

  // Updates the global settings
  async updateSettings(
    dto: UpdateAdminSettingsDto,
    me: any,
  ): Promise<AdminSettingsEntity> {
    if (!this.isSuperAdmin(me)) {
      throw new ForbiddenException(
        "You do not have permission to modify platform settings.",
      );
    }

    const settings = await this.getSettings();

    // Merge incoming socials with existing ones so we don't accidentally delete omitted fields
    const updatedSocials = {
      ...settings.socials,
      ...(dto.socials || {}),
    };

    // Update entity properties
    Object.assign(settings, {
      ...dto,
      socials: updatedSocials,
    });

    return await this.settingsRepo.save(settings);
  }
}
