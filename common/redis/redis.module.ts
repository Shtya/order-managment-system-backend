import { ConfigModule } from "@nestjs/config";
import redisConfig from "./redis.config";
import { Module } from "@nestjs/common";
import { RedisService } from "./RedisService";


@Module({
    imports: [
        ConfigModule.forFeature(redisConfig),
    ],
    providers: [RedisService],
    exports: [RedisService],
})
export class RedisModule { }