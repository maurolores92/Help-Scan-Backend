import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { assertPlatformSuperAdmin } from '../../common/utils/tenant-scope.util';
import { CreateDemoRequestDto } from './dto/create-demo-request.dto';
import { QueryDemoRequestDto } from './dto/query-demo-request.dto';
import { UpdateDemoRequestStatusDto } from './dto/update-demo-request-status.dto';
import { DemoRequestsService } from './demo-requests.service';

/**
 * Controlador de solicitudes de demostración:
 * - `POST /demo-requests` es público para la landing web (persiste y envía por SMTP).
 * - `GET`, `PATCH`, `DELETE` están reservados exclusivamente al Super Administrador de plataforma.
 */
@Controller('demo-requests')
export class DemoRequestsController {
  constructor(private readonly demoRequestsService: DemoRequestsService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Body() dto: CreateDemoRequestDto) {
    return await this.demoRequestsService.sendDemoRequest(dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get()
  async findAll(@Query() query: QueryDemoRequestDto, @GetUser() user: any) {
    assertPlatformSuperAdmin(
      user,
      'Acceso denegado: El módulo de Demos está reservado exclusivamente para el Super Administrador de la plataforma.',
    );
    return await this.demoRequestsService.findAll(query);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDemoRequestStatusDto,
    @GetUser() user: any,
  ) {
    assertPlatformSuperAdmin(
      user,
      'Acceso denegado: Solo el Super Administrador puede actualizar el estado de una solicitud de demo.',
    );
    return await this.demoRequestsService.updateStatus(id, dto, user.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @GetUser() user: any) {
    assertPlatformSuperAdmin(
      user,
      'Acceso denegado: Solo el Super Administrador puede eliminar solicitudes de demo.',
    );
    return await this.demoRequestsService.remove(id, user.id);
  }
}
