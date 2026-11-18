import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectDocumentDto {
  @IsNotEmpty({ message: 'El motivo de rechazo es obligatorio.' })
  @IsString()
  @MaxLength(500)
  reason: string;
}
