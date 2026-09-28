import { Body, Controller, Get, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { randomBytes } from 'crypto';
import { AllowOnboarding, Public, RawResponse } from '../../common/decorators';
import { RequestContext } from '../../common/context/request-context';
import { Db, InjectDb } from '../../common/prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { StorageService } from '../../integrations/storage.service';

interface UploadedBlob {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

/** Purposes whose files may be fetched without authentication (rendered on public pages and emails). */
const PUBLIC_PURPOSES = new Set(['logo', 'branding', 'product', 'avatar']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif']);
const MAX_BYTES = 5 * 1024 * 1024;

@ApiTags('Files')
@Controller('files')
export class FilesController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @AllowOnboarding()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async upload(@UploadedFile() file: UploadedBlob | undefined, @Body('purpose') purpose = 'attachment') {
    if (!file) throw AppError.validation('No file uploaded.');
    if (PUBLIC_PURPOSES.has(purpose) && !IMAGE_TYPES.has(file.mimetype)) throw AppError.validation('Only image files are allowed.');
    const tenantId = RequestContext.requireTenantId();
    const ext = file.originalname.includes('.') ? file.originalname.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin';
    const key = `${tenantId}/${purpose}/${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;
    await this.storage.put(key, file.buffer, file.mimetype);
    const row = await this.db.fileObject.create({
      data: { tenantId, key, contentType: file.mimetype, size: file.size, purpose, createdBy: RequestContext.userId },
    });
    return { id: row.id, url: `${env().APP_URL}/api/v1/files/${row.id}`, contentType: row.contentType, size: row.size };
  }

  @Get(':id')
  @Public()
  @RawResponse()
  async download(@Param('id') id: string, @Res() res: Response) {
    const file = await this.db.fileObject.findUnique({ where: { id } });
    if (!file || !PUBLIC_PURPOSES.has(file.purpose)) throw AppError.notFound('File');
    const body = await this.storage.get(file.key);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (file.contentType === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(body);
  }
}
