import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { TenantsModule } from '../tenants/tenants.module';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({
        secret: env().JWT_ACCESS_SECRET,
        signOptions: { expiresIn: env().JWT_ACCESS_TTL_SECONDS, issuer: 'therapyos' },
        verifyOptions: { issuer: 'therapyos' },
      }),
    }),
    TenantsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, OtpService],
  exports: [AuthService, TokenService, OtpService],
})
export class AuthModule {}
