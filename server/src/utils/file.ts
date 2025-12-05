import { HttpException, StreamableFile } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { access, constants } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import { CacheControl } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { ImmichReadStream, StorageRepository } from 'src/repositories/storage.repository';
import { isConnectionAborted } from 'src/utils/misc';

export function getFileNameWithoutExtension(path: string): string {
  return basename(path, extname(path));
}

export function getFilenameExtension(path: string): string {
  return extname(path);
}

export function getLivePhotoMotionFilename(stillName: string, motionName: string) {
  return getFileNameWithoutExtension(stillName) + extname(motionName);
}

export class ImmichFileResponse {
  public readonly path!: string;
  public readonly contentType!: string;
  public readonly cacheControl!: CacheControl;
  public readonly fileName?: string;

  constructor(response: ImmichFileResponse) {
    Object.assign(this, response);
  }
}
type SendFile = Parameters<Response['sendFile']>;
type SendFileOptions = SendFile[1];

const cacheControlHeaders: Record<CacheControl, string | null> = {
  [CacheControl.PrivateWithCache]: 'private, max-age=86400, no-transform',
  [CacheControl.PrivateWithoutCache]: 'private, no-cache, no-transform',
  [CacheControl.None]: null, // falsy value to prevent adding Cache-Control header
};

/**
 * Check if the given path is a cloud storage path (not local filesystem).
 * Cloud paths have format: host/bucket/key (e.g., s3.amazonaws.com/bucket/file)
 * Local paths start with '/'
 */
function isCloudPath(filepath: string): boolean {
  // Local filesystem paths start with '/'
  if (filepath.startsWith('/')) {
    return false;
  }

  // Check if it looks like a cloud path (host/bucket/key format)
  // Cloud paths should have at least 3 segments and first segment should contain a dot (domain)
  const parts = filepath.split('/');
  if (parts.length >= 3 && parts[0].includes('.')) {
    return true;
  }

  // Otherwise it's a relative path, not a cloud path
  return false;
}

export const sendFile = async (
  res: Response,
  next: NextFunction,
  handler: () => Promise<ImmichFileResponse>,
  logger: LoggingRepository,
  storageRepository?: StorageRepository,
): Promise<void> => {
  // promisified version of 'res.sendFile' for cleaner async handling
  const _sendFile = (path: string, options: SendFileOptions) =>
    promisify<string, SendFileOptions>(res.sendFile).bind(res)(path, options);

  try {
    const file = await handler();
    const cacheControlHeader = cacheControlHeaders[file.cacheControl];
    if (cacheControlHeader) {
      // set the header to Cache-Control
      res.set('Cache-Control', cacheControlHeader);
    }

    res.header('Content-Type', file.contentType);
    if (file.fileName) {
      res.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    }

    // Check if this is a cloud storage path
    if (isCloudPath(file.path) && storageRepository) {
      // Stream from cloud storage
      const { stream, length, type } = await storageRepository.createReadStream(file.path, file.contentType);

      if (length) {
        res.header('Content-Length', length.toString());
      }
      if (type) {
        res.header('Content-Type', type);
      }

      // Pipe the stream to the response
      stream.pipe(res);

      // Handle stream errors
      stream.on('error', (error) => {
        if (!res.headersSent && !isConnectionAborted(error)) {
          logger.error(`Error streaming file from cloud storage: ${error}`, error.stack);
          res.header('Cache-Control', 'none');
          next(error);
        }
      });

      return;
    }

    // Local file: use existing logic
    await access(file.path, constants.R_OK);

    return await _sendFile(file.path, { dotfiles: 'allow' });
  } catch (error: Error | any) {
    // ignore client-closed connection
    if (isConnectionAborted(error) || res.headersSent) {
      return;
    }

    // log non-http errors
    if (error instanceof HttpException === false) {
      logger.error(`Unable to send file: ${error}`, error.stack);
    }

    res.header('Cache-Control', 'none');
    next(error);
  }
};

export const asStreamableFile = ({ stream, type, length }: ImmichReadStream) => {
  return new StreamableFile(stream, { type, length });
};
