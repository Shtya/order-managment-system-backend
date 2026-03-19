import { ConfigModule } from "@nestjs/config";
import redisConfig from "./redis.config";
import { Global, Module } from "@nestjs/common";
import { RedisService } from "./RedisService";


@Global()
@Module({
    imports: [
        ConfigModule.forFeature(redisConfig),
    ],
    providers: [RedisService],
    exports: [RedisService],
})
export class RedisModule { }