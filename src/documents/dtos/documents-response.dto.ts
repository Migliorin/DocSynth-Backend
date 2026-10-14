import { ApiProperty } from '@nestjs/swagger';

export class DocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  objectKey!: string;

  @ApiProperty()
  originalName!: string;

  @ApiProperty({ type: String, nullable: true })
  title!: string | null;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty()
  size!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  jobId!: string | null;

  @ApiProperty({ enum: ['QUEUED', 'EXTRACTING', 'EXTRACTED', 'SUMMARIZING', 'CANCELLING', 'CANCELLED', 'COMPLETED', 'FAILED'] })
  ocrStatus!: string;

  @ApiProperty({ type: String, nullable: true })
  markdownKey!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ocrError!: string | null;

  @ApiProperty({ enum: ['PUR', 'RDA'] })
  type!: 'PUR' | 'RDA';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  userId!: string | null;

  @ApiProperty({ type: [String] })
  topics!: string[];

  @ApiProperty({ type: [String] })
  questions!: string[];

  @ApiProperty()
  summaryLevel!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class SummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ format: 'uuid' })
  generationId!: string;

  @ApiProperty()
  content!: string;

  @ApiProperty({ type: [String] })
  topics!: string[];

  @ApiProperty({ type: [String] })
  questions!: string[];

  @ApiProperty()
  summaryLevel!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class DocumentDetailsResponseDto extends DocumentResponseDto {
  @ApiProperty({ type: String, nullable: true })
  generatedSummary!: string | null;
}

export class ListDocumentsResponseDto {
  @ApiProperty({ type: () => [DocumentResponseDto] })
  items!: DocumentResponseDto[];

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  nextCursor!: string | null;

  @ApiProperty()
  total!: number;
}

export class ListSummariesResponseDto {
  @ApiProperty({ type: () => [SummaryResponseDto] })
  items!: SummaryResponseDto[];

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  nextCursor!: string | null;

  @ApiProperty()
  total!: number;
}

export class CancelGenerationResponseDto {
  @ApiProperty({ enum: ['CANCELLING', 'CANCELLED'] })
  status!: string;
}
