import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateClientDto {
  @IsString()
  @IsNotEmpty({ message: 'La razón social o nombre del cliente es obligatorio' })
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tradeName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxIdType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  taxId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  taxCondition?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  iibbNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  iibbCondition?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  erpCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  contactName?: string | null;

  @IsOptional()
  @IsEmail({}, { message: 'El correo electrónico no tiene un formato válido' })
  @MaxLength(120)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  secondaryPhone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  province?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  paymentTerms?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  cbu?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
