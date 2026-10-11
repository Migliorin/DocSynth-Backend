import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly bucket = process.env.S3_BUCKET ?? 'docsynth-pdfs';
  private readonly client = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'docsynth',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'docsynth-local-password',
    },
  });

  async onModuleInit() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  upload(key: string, body: Buffer) {
    return this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/pdf',
      }),
    );
  }

  delete(key: string) {
    return this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  get(key: string) {
    return this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
