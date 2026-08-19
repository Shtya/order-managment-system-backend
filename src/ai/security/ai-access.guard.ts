import {
  CanActivate,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { AI_CONFIG_TOKEN } from "../ai.constants";
import { AiConfig } from "../interfaces/provider-config.interface";

@Injectable()
export class AiAccessGuard implements CanActivate {
  constructor(@Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig) {}

  canActivate(): boolean {
    if (!this.config.enabled) {
      throw new ForbiddenException({
        message: "AI module is disabled",
        code: "AI_MODULE_DISABLED",
      });
    }
    return true;
  }
}
