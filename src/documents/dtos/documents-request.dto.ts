import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ListDocumentsQueryDto {
  @ApiPropertyOptional({ enum: ['PUR', 'RDA'] })
  type?: string;

  @ApiPropertyOptional({ description: 'ID do último documento da página anterior.' })
  cursor?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50 })
  limit?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  search?: string;
}

export class ListSummariesQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50 })
  limit?: string;

  @ApiPropertyOptional({ description: 'ID da última síntese da página anterior.' })
  cursor?: string;
}

export class UploadDocumentDto {
  @ApiProperty({ enum: ['PUR', 'RDA'] })
  type!: 'PUR' | 'RDA';

  @ApiPropertyOptional({ maxLength: 120 })
  title?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  description?: string;
}

export class GenerateDocumentDto {
  @ApiProperty({ type: [String], maxItems: 30 })
  topics!: string[];

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  questions?: string[];

  @ApiPropertyOptional({ enum: ['concise', 'balanced', 'deep'], default: 'balanced' })
  summaryLevel?: 'concise' | 'balanced' | 'deep';
}
