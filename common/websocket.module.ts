import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppGateway } from 'common/app.gateway';
import { User } from 'entities/user.entity';
import { UserWhatsappAccountAccessEntity, WhatsappMessageEntity } from 'entities/whatsapp.entity';

@Global()
@Module({
    imports: [
        JwtModule.register({}), // 👈 يوفّر JwtService
        TypeOrmModule.forFeature([User, UserWhatsappAccountAccessEntity, WhatsappMessageEntity]), // 👈 يوفّر repositories
    ],
    providers: [AppGateway],
    exports: [AppGateway], // 👈 مهم جداً
})
export class WebSocketModule { }
