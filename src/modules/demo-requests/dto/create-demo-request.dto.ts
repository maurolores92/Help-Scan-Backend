import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Payload público para solicitar una demostración de Help Scan desde la web landing.
 */
export class CreateDemoRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre y apellido es obligatorio.' })
  @MaxLength(120)
  fullName: string;

  @IsString()
  @IsNotEmpty({ message: 'La empresa o razón social es obligatoria.' })
  @MaxLength(160)
  companyName: string;

  @IsEmail({}, { message: 'Debe ingresar un correo electrónico válido.' })
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio.' })
  @MaxLength(160)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  managementSystem?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  scannersCount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  selectedDemo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  @IsOptional()
  @IsString()
  @IsIn(['demo_modal', 'contact_section'])
  source?: 'demo_modal' | 'contact_section';
}
