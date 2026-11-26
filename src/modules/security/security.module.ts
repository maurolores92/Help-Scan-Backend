import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { JwtModule } from '@nestjs/jwt';
import { SecurityIpIntelligence } from './models/security-ip-intelligence.model';
import { SecurityLoginEvent } from './models/security-login-event.model';
import { SecurityErrorLog } from './models/security-error-log.model';
import { SecurityAccessLog } from './models/security-access-log.model';
import { GeoIpService } from './services/geo-ip.service';
import { SecurityService } from './services/security.service';
import { SecurityMonitorBridgeService } from './services/security-monitor-bridge.service';
import { SecurityTrafficMiddleware } from './middleware/security-traffic.middleware';
import { MonitorBridgeGuard } from './guards/monitor-bridge.guard';
import { SecurityController } from './security.controller';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    SequelizeModule.forFeature([
      SecurityIpIntelligence,
      SecurityLoginEvent,
      SecurityErrorLog,
      SecurityAccessLog,
    ]),
    JwtModule,
    AuditModule,
    NotificationsModule,
  ],
  controllers: [SecurityController],
  providers: [
    GeoIpService,
    SecurityService,
    SecurityMonitorBridgeService,
    SecurityTrafficMiddleware,
    MonitorBridgeGuard,
  ],
  exports: [
    GeoIpService,
    SecurityService,
    SecurityMonitorBridgeService,
    MonitorBridgeGuard,
  ],
})
export class SecurityModule {}
