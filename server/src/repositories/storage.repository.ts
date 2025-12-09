import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import chokidar, { ChokidarOptions } from 'chokidar';
import { escapePath, glob, globStream } from 'fast-glob';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync, mkdirSync, ReadOptionsWithBuffer } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CrawlOptionsDto, WalkOptionsDto } from 'src/dtos/library.dto';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { mimeTypes } from 'src/utils/mime-types';

interface ParsedCloudPath {
  endpoint: string;
  bucket: string;
  key: string;
}

export interface WatchEvents {
  onReady(): void;
  onAdd(path: string): void;
  onChange(path: string): void;
  onUnlink(path: string): void;
  onError(error: Error): void;
}

export interface ImmichReadStream {
  stream: Readable;
  type?: string;
  length?: number;
}

export interface ImmichZipStream extends ImmichReadStream {
  addFile: (inputPath: string, filename: string) => void;
  finalize: () => Promise<void>;
}

export interface DiskUsage {
  available: number;
  free: number;
  total: number;
}

export interface UploadResult {
  path: string;
  size: number;
  checksum?: Buffer;
}

export interface UploadOptions {
  computeChecksum?: boolean;
}

@Injectable()
export class StorageRepository {
  private s3Clients: Map<string, S3Client> = new Map();

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(StorageRepository.name);
  }

  /**
   * Get or create an S3 client for the given endpoint.
   * S3 clients are cached per endpoint.
   * Credentials are read from environment variables:
   * - AWS_ACCESS_KEY_ID
   * - AWS_SECRET_ACCESS_KEY
   * - AWS_REGION (optional, defaults to 'auto')
   */
  private getS3Client(endpoint: string): S3Client {
    if (!this.s3Clients.has(endpoint)) {
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const region = process.env.AWS_REGION || 'auto';

      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          'AWS credentials not found. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.',
        );
      }

      const client = new S3Client({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
        endpoint,
        forcePathStyle: true, // Required for S3-compatible services
      });

      this.s3Clients.set(endpoint, client);
      this.logger.log(`S3 client created for endpoint: ${endpoint} (region: ${region})`);
    }

    return this.s3Clients.get(endpoint)!;
  }

  /**
   * Parse cloud storage path into endpoint, bucket, and key components.
   * Expected format: https://endpoint.com/bucket/path/to/file.jpg
   *
   * Example:
   * - https://82e063242560115e5d606dd969fcf936.r2.cloudflarestorage.com/my-bucket/upload/photo.jpg
   */
  private parseCloudPath(filepath: string): ParsedCloudPath {
    if (!filepath.startsWith('https://')) {
      throw new Error(`Invalid cloud storage path format: ${filepath} - must be a full URL (https://)`);
    }

    try {
      const url = new URL(filepath);
      // Extract endpoint with protocol: https://endpoint.com
      const endpoint = `${url.protocol}//${url.host}`;
      // Extract path without leading slash: /bucket/path/file.jpg -> bucket/path/file.jpg
      const pathPart = url.pathname.substring(1);

      // Split path into bucket and key
      const parts = pathPart.split('/');
      if (parts.length < 2) {
        throw new Error(`Invalid cloud storage path format: ${filepath} - must have at least bucket/key`);
      }

      const bucket = parts[0];
      const key = parts.slice(1).join('/');

      return { endpoint, bucket, key };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Invalid cloud storage URL format: ${filepath}`);
      }
      throw error;
    }
  }

  /**
   * Check if the given path is a remote storage path.
   * Returns true if the path is in cloud storage format (not a local filesystem path).
   * Remote storage paths must be full URLs starting with https://
   *
   * Example: https://endpoint.com/bucket/path/to/file.jpg
   */
  private isRemote(filepath?: string): boolean {
    if (!filepath) {
      return false;
    }

    // Full URL format (https://)
    return filepath.startsWith('https://');
  }

  /**
   * Get S3 endpoint, bucket and key from the cloud path.
   */
  private getS3BucketAndKey(filepath: string): { endpoint: string; bucket: string; key: string } {
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    return { endpoint, bucket, key };
  }

  /**
   * Generate a presigned URL for reading a file from remote storage.
   * This allows temporary access to private objects without downloading them first.
   *
   * @param filepath - The remote storage path (https://endpoint.com/bucket/key)
   * @param expiresIn - URL expiration time in seconds (default: 3600 = 1 hour)
   * @returns Presigned URL for direct access to the file
   */
  async getSignedUrl(filepath: string, expiresIn: number = 3600): Promise<string> {
    if (!this.isRemote(filepath)) {
      // Local filesystem: return the path as-is (no presigned URL needed)
      return filepath;
    }

    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    // Type assertion needed due to @aws-sdk version mismatch
    return awsGetSignedUrl(client as any, command, { expiresIn });
  }

  async realpath(filepath: string) {
    if (!this.isRemote(filepath)) {
      return fs.realpath(filepath);
    }
    // Remote storage: Return path as-is (no symlinks in remote storage)
    return filepath;
  }

  async readdir(folder: string): Promise<string[]> {
    if (!this.isRemote(folder)) {
      return fs.readdir(folder);
    }
    // Remote storage: List objects with folder prefix
    throw new Error('readdir is not supported for remote storage. Use crawl() or walk() instead.');
  }

  async copyFile(source: string, target: string) {
    // Check if both source and target use the same storage backend
    const sourceIsRemote = this.isRemote(source);
    const targetIsRemote = this.isRemote(target);

    if (!sourceIsRemote && !targetIsRemote) {
      // Both are local filesystem
      return fs.copyFile(source, target);
    }

    if (sourceIsRemote && targetIsRemote) {
      // Both are remote: Use CopyObjectCommand
      const { endpoint: sourceEndpoint, bucket: sourceBucket, key: sourceKey } = this.getS3BucketAndKey(source);
      const { endpoint: targetEndpoint, bucket: targetBucket, key: targetKey } = this.getS3BucketAndKey(target);

      if (sourceEndpoint !== targetEndpoint) {
        throw new Error(`Cannot copy between different S3 endpoints: ${sourceEndpoint} -> ${targetEndpoint}`);
      }

      if (sourceBucket !== targetBucket) {
        throw new Error(`Cannot copy between different remote storage buckets: ${sourceBucket} -> ${targetBucket}`);
      }

      const client = this.getS3Client(targetEndpoint);

      const copyCommand = new CopyObjectCommand({
        Bucket: targetBucket,
        CopySource: `${sourceBucket}/${sourceKey}`,
        Key: targetKey,
      });
      await client.send(copyCommand);
      return;
    }

    // Mixed storage (remote and local) - not supported
    throw new Error(`Cannot copy between different storage backends: ${source} -> ${target}`);
  }

  async stat(filepath: string) {
    if (!this.isRemote(filepath)) {
      return fs.stat(filepath);
    }

    // Remote storage: Get object metadata
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);

    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const response = await client.send(command);

    // Read custom metadata for timestamps if available
    const metadata = response.Metadata || {};
    let mtime = response.LastModified || new Date();
    let atime = response.LastModified || new Date();

    // Use custom metadata if available (ISO 8601 format)
    if (metadata['immich-last-modified']) {
      try {
        mtime = new Date(metadata['immich-last-modified']);
      } catch {
        // Fallback to LastModified if parsing fails
      }
    }
    if (metadata['immich-last-accessed']) {
      try {
        atime = new Date(metadata['immich-last-accessed']);
      } catch {
        // Fallback to LastModified if parsing fails
      }
    }

    // Create a Stats-like object
    return {
      size: response.ContentLength || 0,
      mtime,
      atime,
      birthtime: response.LastModified || new Date(),
      mtimeMs: mtime.getTime(),
      atimeMs: atime.getTime(),
      birthtimeMs: response.LastModified?.getTime() || 0,
      isFile: () => true,
      isDirectory: () => false,
    } as any;
  }

  async createFile(filepath: string, buffer: Buffer) {
    if (!this.isRemote(filepath)) {
      return fs.writeFile(filepath, buffer, { flag: 'wx' });
    }

    // Remote storage: Upload buffer
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
    });
    await client.send(command);
  }

  createWriteStream(filepath: string): Writable {
    return createWriteStream(filepath, { flags: 'w' });
  }

  /**
   * Upload a file from a readable stream to the specified destination.
   * Optionally computes a SHA1 checksum while streaming.
   *
   * @param stream - The readable stream to upload from
   * @param destination - The full path where the file should be written
   * @param options - Upload options (e.g., computeChecksum)
   * @returns Upload result containing path, size, and optional checksum
   */
  async uploadFromStream(stream: Readable, destination: string, options: UploadOptions = {}): Promise<UploadResult> {
    let checksum: Buffer | undefined;
    let size = 0;

    // If checksum computation is requested, set up hash stream
    if (options.computeChecksum) {
      const hash = createHash('sha1');

      stream.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
      });

      stream.on('end', () => {
        checksum = hash.digest();
      });

      stream.on('error', () => {
        hash.destroy();
      });
    } else {
      // Track size even without checksum
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
      });
    }

    if (!this.isRemote(destination)) {
      // Local storage: Ensure the directory exists and write to file
      const directory = path.dirname(destination);
      this.mkdirSync(directory);

      const writeStream = this.createWriteStream(destination);
      await pipeline(stream, writeStream);

      return {
        path: destination,
        size,
        checksum,
      };
    }

    // Remote storage: Upload stream to S3
    const { endpoint, bucket, key } = this.parseCloudPath(destination);
    const client = this.getS3Client(endpoint);
    this.logger.debug(`Uploading file to S3: bucket=${bucket}, key=${key}`);

    try {
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: stream,
        },
      });

      await upload.done();
      this.logger.debug(`Successfully uploaded file to S3: key=${key}, size=${size} bytes`);

      return {
        path: destination,
        size,
        checksum,
      };
    } catch (error) {
      this.logger.error(`Failed to upload file to S3: key=${key}`, error);
      throw error;
    }
  }

  async createOrOverwriteFile(filepath: string, buffer: Buffer) {
    if (!this.isRemote(filepath)) {
      return fs.writeFile(filepath, buffer, { flag: 'w' });
    }

    // Remote storage: Upload buffer (overwrites if exists)
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
    });
    await client.send(command);
  }

  async overwriteFile(filepath: string, buffer: Buffer) {
    if (!this.isRemote(filepath)) {
      return fs.writeFile(filepath, buffer, { flag: 'r+' });
    }

    // Remote storage: Upload buffer (overwrites existing file)
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
    });
    await client.send(command);
  }

  async rename(source: string, target: string) {
    // Check if both source and target use the same storage backend
    const sourceIsRemote = this.isRemote(source);
    const targetIsRemote = this.isRemote(target);

    if (!sourceIsRemote && !targetIsRemote) {
      // Both are local filesystem
      return fs.rename(source, target);
    }

    if (sourceIsRemote && targetIsRemote) {
      // Both are remote: Use copy and delete
      const { endpoint: sourceEndpoint, bucket: sourceBucket, key: sourceKey } = this.getS3BucketAndKey(source);
      const { endpoint: targetEndpoint, bucket: targetBucket, key: targetKey } = this.getS3BucketAndKey(target);

      if (sourceEndpoint !== targetEndpoint) {
        throw new Error(`Cannot rename between different S3 endpoints: ${sourceEndpoint} -> ${targetEndpoint}`);
      }

      if (sourceBucket !== targetBucket) {
        throw new Error(`Cannot rename between different remote storage buckets: ${sourceBucket} -> ${targetBucket}`);
      }

      const client = this.getS3Client(targetEndpoint);

      const copyCommand = new CopyObjectCommand({
        Bucket: targetBucket,
        CopySource: `${sourceBucket}/${sourceKey}`,
        Key: targetKey,
      });
      await client.send(copyCommand);

      // Delete source after successful copy
      await this.unlink(source);
      return;
    }

    // Mixed storage (remote and local) - not supported
    throw new Error(`Cannot rename between different storage backends: ${source} -> ${target}`);
  }

  async utimes(filepath: string, atime: Date, mtime: Date) {
    if (!this.isRemote(filepath)) {
      return fs.utimes(filepath, atime, mtime);
    }

    // Remote storage: Store timestamps in custom metadata
    // S3 doesn't support setting LastModified directly, so we use custom metadata
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);

    // Get current object metadata
    const headCommand = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const headResponse = await client.send(headCommand);

    // Copy object with updated metadata (MetadataDirective: REPLACE)
    const copyCommand = new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${key}`,
      Key: key,
      Metadata: {
        ...(headResponse.Metadata || {}),
        'immich-last-accessed': atime.toISOString(),
        'immich-last-modified': mtime.toISOString(),
      },
      MetadataDirective: 'REPLACE',
    });
    await client.send(copyCommand);
  }

  createZipStream(): ImmichZipStream {
    const archive = archiver('zip', { store: true });

    const addFile = (input: string, filename: string) => {
      archive.file(input, { name: filename, mode: 0o644 });
    };

    const finalize = () => archive.finalize();

    return { stream: archive, addFile, finalize };
  }

  async createReadStream(filepath: string, mimeType?: string | null): Promise<ImmichReadStream> {
    if (!this.isRemote(filepath)) {
      const { size } = await fs.stat(filepath);
      await fs.access(filepath, constants.R_OK);
      return {
        stream: createReadStream(filepath),
        length: size,
        type: mimeType || undefined,
      };
    }

    // Remote storage: Stream from S3
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const response = await client.send(command);

    if (!response.Body) {
      throw new Error(`Failed to create read stream from S3: ${filepath}`);
    }

    return {
      stream: response.Body as Readable,
      length: response.ContentLength,
      type: mimeType || response.ContentType || undefined,
    };
  }

  async readFile(filepath: string, options?: ReadOptionsWithBuffer<Buffer>): Promise<Buffer> {
    if (!this.isRemote(filepath)) {
      const file = await fs.open(filepath);
      try {
        const { buffer } = await file.read(options);
        return buffer as Buffer;
      } finally {
        await file.close();
      }
    }

    // Remote storage: Download file
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const response = await client.send(command);

    if (!response.Body) {
      throw new Error(`Failed to read file from S3: ${filepath}`);
    }

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as Readable) {
      chunks.push(Buffer.from(chunk));
    }

    let buffer = Buffer.concat(chunks);

    // Handle options (offset and length)
    if (options?.position !== undefined || options?.length !== undefined) {
      const start = Number(options.position || 0);
      const end = options.length ? start + options.length : undefined;
      buffer = buffer.subarray(start, end);
    }

    return buffer;
  }

  async readTextFile(filepath: string): Promise<string> {
    if (!this.isRemote(filepath)) {
      return fs.readFile(filepath, 'utf8');
    }

    // Remote storage: Read file and convert to string
    const buffer = await this.readFile(filepath);
    return buffer.toString('utf8');
  }

  async checkFileExists(filepath: string, mode = constants.F_OK): Promise<boolean> {
    if (!this.isRemote(filepath)) {
      try {
        await fs.access(filepath, mode);
        return true;
      } catch {
        return false;
      }
    }

    // Remote storage: Check if object exists
    try {
      const { endpoint, bucket, key } = this.parseCloudPath(filepath);
      const client = this.getS3Client(endpoint);

      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      await client.send(command);
      return true;
    } catch {
      return false;
    }
  }

  async unlink(file: string) {
    if (!this.isRemote(file)) {
      try {
        await fs.unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          this.logger.warn(`File ${file} does not exist.`);
        } else {
          throw error;
        }
      }
      return;
    }

    // Remote storage: Delete object
    try {
      const { endpoint, bucket, key } = this.parseCloudPath(file);
      const client = this.getS3Client(endpoint);

      const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      await client.send(command);
    } catch (error) {
      this.logger.warn(`Failed to delete S3 object ${file}: ${error}`);
      throw error;
    }
  }

  async unlinkDir(folder: string, options: { recursive?: boolean; force?: boolean }) {
    await fs.rm(folder, options);
  }

  async removeEmptyDirs(directory: string, self: boolean = false) {
    // lstat does not follow symlinks (in contrast to stat)
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory()) {
      return;
    }

    const files = await fs.readdir(directory);
    await Promise.all(files.map((file) => this.removeEmptyDirs(path.join(directory, file), true)));

    if (self) {
      const updated = await fs.readdir(directory);
      if (updated.length === 0) {
        await fs.rmdir(directory);
      }
    }
  }

  mkdirSync(filepath: string): void {
    if (!existsSync(filepath)) {
      mkdirSync(filepath, { recursive: true });
    }
  }

  existsSync(filepath: string) {
    return existsSync(filepath);
  }

  async checkDiskUsage(folder: string): Promise<DiskUsage> {
    // Check if folder is a cloud storage path (doesn't start with '/')
    if (!folder.startsWith('/')) {
      // Cloud storage: Return fixed maximum values (8 exbibytes = 8 * 1024^6 bytes)
      const eightExbibytes = 8 * Math.pow(1024, 6);
      return {
        available: eightExbibytes,
        free: eightExbibytes,
        total: eightExbibytes,
      };
    }

    // Local filesystem
    const stats = await fs.statfs(folder);
    return {
      available: stats.bavail * stats.bsize,
      free: stats.bfree * stats.bsize,
      total: stats.blocks * stats.bsize,
    };
  }

  crawl(crawlOptions: CrawlOptionsDto): Promise<string[]> {
    const { pathsToCrawl, exclusionPatterns, includeHidden } = crawlOptions;
    if (pathsToCrawl.length === 0) {
      return Promise.resolve([]);
    }

    const globbedPaths = pathsToCrawl.map((path) => this.asGlob(path));

    return glob(globbedPaths, {
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      dot: includeHidden,
      ignore: exclusionPatterns,
    });
  }

  async *walk(walkOptions: WalkOptionsDto): AsyncGenerator<string[]> {
    const { pathsToCrawl, exclusionPatterns, includeHidden } = walkOptions;
    if (pathsToCrawl.length === 0) {
      async function* emptyGenerator() {}
      return emptyGenerator();
    }

    const globbedPaths = pathsToCrawl.map((path) => this.asGlob(path));

    const stream = globStream(globbedPaths, {
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      dot: includeHidden,
      ignore: exclusionPatterns,
    });

    let batch: string[] = [];
    for await (const value of stream) {
      batch.push(value.toString());
      if (batch.length === walkOptions.take) {
        yield batch;
        batch = [];
      }
    }

    if (batch.length > 0) {
      yield batch;
    }
  }

  watch(paths: string[], options: ChokidarOptions, events: Partial<WatchEvents>) {
    const watcher = chokidar.watch(paths, options);

    watcher.on('ready', () => events.onReady?.());
    watcher.on('add', (path) => events.onAdd?.(path));
    watcher.on('change', (path) => events.onChange?.(path));
    watcher.on('unlink', (path) => events.onUnlink?.(path));
    watcher.on('error', (error) => events.onError?.(error as Error));

    return () => watcher.close();
  }

  /**
   * Execute a callback that writes to a file.
   * For local storage, this simply passes through the path.
   * For remote storage, this provides a temporary file path and uploads the result.
   *
   * @param filepath - The destination file path (local or remote path)
   * @param callback - Function that writes to the provided local path
   * @returns The result of the callback
   */
  async writeFile<T>(filepath: string, callback: (localPath: string) => Promise<T>): Promise<T> {
    if (!this.isRemote(filepath)) {
      // Local storage: just pass through
      return await callback(filepath);
    }

    // Remote storage: provide temp file, then upload to remote storage
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);
    const tempFile = path.join(tmpdir(), `immich-write-${Date.now()}-${path.basename(filepath)}`);

    this.logger.debug(`Writing to temporary file for S3 upload: ${tempFile}`);

    try {
      // Execute callback with temp file
      const result = await callback(tempFile);

      // Upload to S3
      this.logger.debug(`Uploading temporary file to S3: bucket=${bucket}, key=${key}`);
      const buffer = await fs.readFile(tempFile);

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
      });
      await client.send(command);

      this.logger.debug(`Successfully uploaded to S3: key=${key}`);

      return result;
    } catch (error) {
      this.logger.error(`Failed to write file to S3: key=${key}`, error);
      throw error;
    } finally {
      // Cleanup temp file
      try {
        await fs.unlink(tempFile);
        this.logger.debug(`Cleaned up temp file: ${tempFile}`);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Execute a callback with a local file path for reading.
   * For local storage, this simply passes through the path.
   * For remote storage, this downloads to a temporary file.
   *
   * @param filepath - The file path (local or remote key)
   * @param callback - Function to execute with the local path
   * @returns The result of the callback
   */
  async withLocalPath<T>(filepath: string, callback: (localPath: string) => Promise<T>): Promise<T> {
    if (!this.isRemote(filepath)) {
      // Local storage: just pass through
      return await callback(filepath);
    }

    // Remote storage: download to temp file
    const { endpoint, bucket, key } = this.parseCloudPath(filepath);
    const client = this.getS3Client(endpoint);
    const tempFile = path.join(tmpdir(), `immich-${Date.now()}-${path.basename(filepath)}`);

    this.logger.debug(`Downloading file from S3: bucket=${bucket}, key=${key}`);

    try {
      // Download from S3
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await client.send(command);

      if (!response.Body) {
        throw new Error(`Failed to download file from S3: ${filepath} (key: ${key})`);
      }

      // Write to temp file
      const writeStream = createWriteStream(tempFile);
      await pipeline(response.Body as Readable, writeStream);

      this.logger.debug(`Successfully downloaded file from S3 to temp file: ${tempFile}`);

      // Execute callback with temp file
      return await callback(tempFile);
    } catch (error) {
      this.logger.error(`Failed to download file from S3: key=${key}`, error);
      throw error;
    } finally {
      // Cleanup temp file
      try {
        await fs.unlink(tempFile);
        this.logger.debug(`Cleaned up temp file: ${tempFile}`);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  }

  private asGlob(pathToCrawl: string): string {
    const escapedPath = escapePath(pathToCrawl).replaceAll('"', '["]').replaceAll("'", "[']").replaceAll('`', '[`]');
    const extensions = `*{${mimeTypes.getSupportedFileExtensions().join(',')}}`;
    return `${escapedPath}/**/${extensions}`;
  }
}
