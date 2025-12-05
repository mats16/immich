import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { StorageAsset } from 'src/database';
import { AssetFileType, AssetPathType, ImageFormat, PathType, PersonPathType, StorageFolder } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MoveRepository } from 'src/repositories/move.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { getAssetFile } from 'src/utils/asset.util';
import { getConfig } from 'src/utils/config';

export interface MoveRequest {
  entityId: string;
  pathType: PathType;
  oldPath: string | null;
  newPath: string;
  assetInfo?: {
    sizeInBytes: number;
    checksum: Buffer;
  };
}

export type GeneratedImageType = AssetPathType.Preview | AssetPathType.Thumbnail | AssetPathType.FullSize;
export type GeneratedAssetType = GeneratedImageType | AssetPathType.EncodedVideo;

export type ThumbnailPathEntity = { id: string; ownerId: string };

let instance: StorageCore | null;

let mediaLocation: string | undefined;

export class StorageCore {
  private constructor(
    private assetRepository: AssetRepository,
    private configRepository: ConfigRepository,
    private cryptoRepository: CryptoRepository,
    private moveRepository: MoveRepository,
    private personRepository: PersonRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(StorageCore.name);
  }

  static create(
    assetRepository: AssetRepository,
    configRepository: ConfigRepository,
    cryptoRepository: CryptoRepository,
    moveRepository: MoveRepository,
    personRepository: PersonRepository,
    storageRepository: StorageRepository,
    systemMetadataRepository: SystemMetadataRepository,
    logger: LoggingRepository,
  ) {
    if (!instance) {
      instance = new StorageCore(
        assetRepository,
        configRepository,
        cryptoRepository,
        moveRepository,
        personRepository,
        storageRepository,
        systemMetadataRepository,
        logger,
      );
    }

    return instance;
  }

  static reset() {
    instance = null;
  }

  static getMediaLocation(): string {
    if (mediaLocation === undefined) {
      throw new Error('Media location is not set.');
    }

    return mediaLocation;
  }

  static setMediaLocation(location: string) {
    mediaLocation = location;
  }

  /**
   * Add storage backend prefix to the path.
   * For cloud storage: IMMICH_MEDIA_LOCATION already contains host/bucket (e.g., "fly.storage.tigris.dev/bucket")
   * For local storage: IMMICH_MEDIA_LOCATION is a directory path (e.g., "/data")
   */
  static addStoragePrefix(localPath: string): string {
    const mediaLocation = StorageCore.getMediaLocation();

    // Check if media location is a cloud path (doesn't start with '/')
    if (!mediaLocation.startsWith('/')) {
      // Cloud storage: IMMICH_MEDIA_LOCATION contains host/bucket
      // Remove leading slash from local path
      const path = localPath.startsWith('/') ? localPath.slice(1) : localPath;
      // Return: <host>/<bucket>/<path>
      return `${mediaLocation}/${path}`;
    }

    // Local storage: return path as-is
    return localPath;
  }

  static getFolderLocation(folder: StorageFolder, userId: string) {
    return join(StorageCore.getBaseFolder(folder), userId);
  }

  static getLibraryFolder(user: { storageLabel: string | null; id: string }) {
    return join(StorageCore.getBaseFolder(StorageFolder.Library), user.storageLabel || user.id);
  }

  static getBaseFolder(folder: StorageFolder) {
    return join(StorageCore.getMediaLocation(), folder);
  }

  static getPersonThumbnailPath(person: ThumbnailPathEntity) {
    const localPath = StorageCore.getNestedPath(StorageFolder.Thumbnails, person.ownerId, `${person.id}.jpeg`);
    return StorageCore.addStoragePrefix(localPath);
  }

  static getImagePath(asset: ThumbnailPathEntity, type: GeneratedImageType, format: 'jpeg' | 'webp') {
    const localPath = StorageCore.getNestedPath(
      StorageFolder.Thumbnails,
      asset.ownerId,
      `${asset.id}-${type}.${format}`,
    );
    return StorageCore.addStoragePrefix(localPath);
  }

  static getEncodedVideoPath(asset: ThumbnailPathEntity) {
    const localPath = StorageCore.getNestedPath(StorageFolder.EncodedVideo, asset.ownerId, `${asset.id}.mp4`);
    return StorageCore.addStoragePrefix(localPath);
  }

  static getAndroidMotionPath(asset: ThumbnailPathEntity, uuid: string) {
    const localPath = StorageCore.getNestedPath(StorageFolder.EncodedVideo, asset.ownerId, `${uuid}-MP.mp4`);
    return StorageCore.addStoragePrefix(localPath);
  }

  static isAndroidMotionPath(originalPath: string) {
    // For cloud storage paths, check if it contains the EncodedVideo folder in the path
    if (!originalPath.startsWith('/')) {
      // Cloud storage path: check if path contains the encoded video folder name
      return originalPath.includes(`/${StorageFolder.EncodedVideo}/`);
    }
    // Local filesystem path
    return originalPath.startsWith(StorageCore.getBaseFolder(StorageFolder.EncodedVideo));
  }

  static isImmichPath(path: string) {
    // For cloud storage paths (not starting with '/'), check if they contain a host/bucket pattern
    // Cloud paths should have format: host/bucket/path (e.g., s3.amazonaws.com/bucket/file)
    if (!path.startsWith('/')) {
      // Check if it looks like a cloud path (contains at least two path segments)
      const parts = path.split('/');
      if (parts.length >= 3 && parts[0].includes('.')) {
        // Likely a cloud path with hostname
        return true;
      }
      // Otherwise it's a relative path, not a cloud path
      return false;
    }

    // For local filesystem paths, check if they're under the media location
    const resolvedPath = resolve(path);
    const resolvedAppMediaLocation = StorageCore.getMediaLocation();
    const normalizedPath = resolvedPath.endsWith('/') ? resolvedPath : resolvedPath + '/';
    const normalizedAppMediaLocation = resolvedAppMediaLocation.endsWith('/')
      ? resolvedAppMediaLocation
      : resolvedAppMediaLocation + '/';
    return normalizedPath.startsWith(normalizedAppMediaLocation);
  }

  async moveAssetImage(asset: StorageAsset, pathType: GeneratedImageType, format: ImageFormat) {
    const { id: entityId, files } = asset;
    const oldFile = getAssetFile(files, pathType);
    return this.moveFile({
      entityId,
      pathType,
      oldPath: oldFile?.path || null,
      newPath: StorageCore.getImagePath(asset, pathType, format),
    });
  }

  async moveAssetVideo(asset: StorageAsset) {
    return this.moveFile({
      entityId: asset.id,
      pathType: AssetPathType.EncodedVideo,
      oldPath: asset.encodedVideoPath,
      newPath: StorageCore.getEncodedVideoPath(asset),
    });
  }

  async movePersonFile(person: { id: string; ownerId: string; thumbnailPath: string }, pathType: PersonPathType) {
    const { id: entityId, thumbnailPath } = person;
    switch (pathType) {
      case PersonPathType.Face: {
        await this.moveFile({
          entityId,
          pathType,
          oldPath: thumbnailPath,
          newPath: StorageCore.getPersonThumbnailPath(person),
        });
      }
    }
  }

  async moveFile(request: MoveRequest) {
    const { entityId, pathType, oldPath, newPath, assetInfo } = request;
    if (!oldPath || oldPath === newPath) {
      return;
    }

    this.ensureFolders(newPath);

    let move = await this.moveRepository.getByEntity(entityId, pathType);
    if (move) {
      this.logger.log(`Attempting to finish incomplete move: ${move.oldPath} => ${move.newPath}`);
      const oldPathExists = await this.storageRepository.checkFileExists(move.oldPath);
      const newPathExists = await this.storageRepository.checkFileExists(move.newPath);
      const newPathCheck = newPathExists ? move.newPath : null;
      const actualPath = oldPathExists ? move.oldPath : newPathCheck;
      if (!actualPath) {
        this.logger.warn('Unable to complete move. File does not exist at either location.');
        return;
      }

      const fileAtNewLocation = actualPath === move.newPath;
      this.logger.log(`Found file at ${fileAtNewLocation ? 'new' : 'old'} location`);

      if (
        fileAtNewLocation &&
        !(await this.verifyNewPathContentsMatchesExpected(move.oldPath, move.newPath, assetInfo))
      ) {
        this.logger.fatal(
          `Skipping move as file verification failed, old file is missing and new file is different to what was expected`,
        );
        return;
      }

      move = await this.moveRepository.update(move.id, { id: move.id, oldPath: actualPath, newPath });
    } else {
      move = await this.moveRepository.create({ entityId, pathType, oldPath, newPath });
    }

    if (pathType === AssetPathType.Original && !assetInfo) {
      this.logger.warn(`Unable to complete move. Missing asset info for ${entityId}`);
      return;
    }

    if (move.oldPath !== newPath) {
      try {
        this.logger.debug(`Attempting to rename file: ${move.oldPath} => ${newPath}`);
        await this.storageRepository.rename(move.oldPath, newPath);
      } catch (error: any) {
        if (error.code !== 'EXDEV') {
          this.logger.warn(
            `Unable to complete move. Error renaming file with code ${error.code} and message: ${error.message}`,
          );
          return;
        }
        this.logger.debug(`Unable to rename file. Falling back to copy, verify and delete`);
        await this.storageRepository.copyFile(move.oldPath, newPath);

        if (!(await this.verifyNewPathContentsMatchesExpected(move.oldPath, newPath, assetInfo))) {
          this.logger.warn(`Skipping move due to file size mismatch`);
          await this.storageRepository.unlink(newPath);
          return;
        }

        const { atime, mtime } = await this.storageRepository.stat(move.oldPath);
        await this.storageRepository.utimes(newPath, atime, mtime);

        try {
          await this.storageRepository.unlink(move.oldPath);
        } catch (error: any) {
          this.logger.warn(`Unable to delete old file, it will now no longer be tracked by Immich: ${error.message}`);
        }
      }
    }

    await this.savePath(pathType, entityId, newPath);
    await this.moveRepository.delete(move.id);
  }

  private async verifyNewPathContentsMatchesExpected(
    oldPath: string,
    newPath: string,
    assetInfo?: { sizeInBytes: number; checksum: Buffer },
  ) {
    const oldStat = await this.storageRepository.stat(oldPath);
    const newStat = await this.storageRepository.stat(newPath);
    const oldPathSize = assetInfo ? assetInfo.sizeInBytes : oldStat.size;
    const newPathSize = newStat.size;
    this.logger.debug(`File size check: ${newPathSize} === ${oldPathSize}`);
    if (newPathSize !== oldPathSize) {
      this.logger.warn(`Unable to complete move. File size mismatch: ${newPathSize} !== ${oldPathSize}`);
      return false;
    }
    const repos = {
      configRepo: this.configRepository,
      metadataRepo: this.systemMetadataRepository,
      logger: this.logger,
    };
    const config = await getConfig(repos, { withCache: true });
    if (assetInfo && config.storageTemplate.hashVerificationEnabled) {
      const { checksum } = assetInfo;
      const newChecksum = await this.cryptoRepository.hashFile(newPath);
      if (!newChecksum.equals(checksum)) {
        this.logger.warn(
          `Unable to complete move. File checksum mismatch: ${newChecksum.toString('base64')} !== ${checksum.toString(
            'base64',
          )}`,
        );
        return false;
      }
      this.logger.debug(`File checksum check: ${newChecksum.toString('base64')} === ${checksum.toString('base64')}`);
    }
    return true;
  }

  ensureFolders(input: string) {
    // Only create directories for local filesystem paths
    // Cloud paths have format: host/bucket/path and don't need directory creation
    const isCloudPath = !input.startsWith('/') && input.split('/').length >= 3 && input.split('/')[0].includes('.');

    if (!isCloudPath) {
      this.storageRepository.mkdirSync(dirname(input));
    }
    // For cloud storage paths, no directory creation needed
  }

  removeEmptyDirs(folder: StorageFolder) {
    return this.storageRepository.removeEmptyDirs(StorageCore.getBaseFolder(folder));
  }

  private savePath(pathType: PathType, id: string, newPath: string) {
    switch (pathType) {
      case AssetPathType.Original: {
        return this.assetRepository.update({ id, originalPath: newPath });
      }
      case AssetPathType.FullSize: {
        return this.assetRepository.upsertFile({ assetId: id, type: AssetFileType.FullSize, path: newPath });
      }
      case AssetPathType.Preview: {
        return this.assetRepository.upsertFile({ assetId: id, type: AssetFileType.Preview, path: newPath });
      }
      case AssetPathType.Thumbnail: {
        return this.assetRepository.upsertFile({ assetId: id, type: AssetFileType.Thumbnail, path: newPath });
      }
      case AssetPathType.EncodedVideo: {
        return this.assetRepository.update({ id, encodedVideoPath: newPath });
      }
      case AssetPathType.Sidecar: {
        return this.assetRepository.update({ id, sidecarPath: newPath });
      }
      case PersonPathType.Face: {
        return this.personRepository.update({ id, thumbnailPath: newPath });
      }
    }
  }

  static getNestedFolder(folder: StorageFolder, ownerId: string, filename: string): string {
    return join(StorageCore.getFolderLocation(folder, ownerId), filename.slice(0, 2), filename.slice(2, 4));
  }

  static getNestedPath(folder: StorageFolder, ownerId: string, filename: string): string {
    return join(this.getNestedFolder(folder, ownerId, filename), filename);
  }

  static getTempPathInDir(dir: string): string {
    return join(dir, `${randomUUID()}.tmp`);
  }
}
