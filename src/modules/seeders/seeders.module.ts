import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { SeedService } from './seeders.service';
import { SeedController } from './seeders.controller';
import { Users } from '../users/users.model';
import { Role } from '../role/role.model';
import { Company } from '../companies/company.model';
import { Plan } from '../plans/plan.model';
import { PlanExchangeConfig } from '../plans/models/plan-exchange-config.model';
import { Permission } from '../permissions/permission.model';

@Module({
  imports: [
    SequelizeModule.forFeature([
      Users,
      Role,
      Company,
      Plan,
      PlanExchangeConfig,
      Permission,
    ]),
  ],
  providers: [SeedService],
  controllers: [SeedController],
  exports: [SeedService],
})
export class SeedModule {}
