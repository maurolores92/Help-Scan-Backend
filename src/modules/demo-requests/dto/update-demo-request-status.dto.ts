import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DemoRequestStatus } from '../demo-request.model';

export class UpdateDemoRequestStatusDto {
  @IsEnum(DemoRequestStatus, {
    message:
      'Estado inválido. Valores permitidos: RECIBIDO, CONTACTADO, INTERESADO, VENDIDO, RECHAZADO.',
  })
  status: DemoRequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
