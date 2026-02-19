import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppGateway } from 'common/app.gateway';
import { User } from 'entities/user.entity';

@Module({
    imports: [
        JwtModule.register({}), // 👈 يوفّر JwtService
        TypeOrmModule.forFeature([User]), // 👈 يوفّر UserRepository
    ],
    providers: [AppGateway],
    exports: [AppGateway], // 👈 مهم جداً
})
export class WebSocketModule { }
