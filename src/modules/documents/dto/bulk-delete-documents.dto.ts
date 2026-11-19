import { ArrayNotEmpty, IsArray, IsInt } from 'class-validator';

export class BulkDeleteDocumentsDto {
  @IsArray({ message: 'Los IDs deben ser un arreglo de números' })
  @ArrayNotEmpty({ message: 'Debe proporcionar al menos un ID de documento' })
  @IsInt({ each: true, message: 'Cada ID debe ser un número entero' })
  ids: number[];
}
