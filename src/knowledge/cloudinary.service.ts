import { Injectable, Logger } from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private config: ConfigService) {
    cloudinary.config({
      cloud_name: this.config.get('CLOUDINARY_CLOUD_NAME'),
      api_key:    this.config.get('CLOUDINARY_API_KEY'),
      api_secret: this.config.get('CLOUDINARY_API_SECRET'),
    });
  }

  async upload(
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<{ url: string; publicId: string }> {
    return new Promise((resolve, reject) => {
      // Determine resource type for Cloudinary
      let resourceType: 'image' | 'video' | 'raw' = 'raw';
      if (mimeType.startsWith('image/')) resourceType = 'image';
      else if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) resourceType = 'video';

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: resourceType,
          folder: 'offset8-kb',
          public_id: `kb_${Date.now()}_${originalName.replace(/[^a-z0-9]/gi, '_')}`,
          use_filename: true,
        },
        (err, result: UploadApiResponse | undefined) => {
          if (err || !result) return reject(err ?? new Error('Upload failed'));
          this.logger.log(`Uploaded to Cloudinary: ${result.public_id}`);
          resolve({ url: result.secure_url, publicId: result.public_id });
        },
      );
      Readable.from(buffer).pipe(uploadStream);
    });
  }
}
