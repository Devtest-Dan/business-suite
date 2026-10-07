export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function signRequest(req: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers?: Record<string, string>;
  payloadHash?: string;
  now?: Date;
  service?: string;
}): Record<string, string>;

export function s3Put(config: S3Config, key: string, body: Uint8Array | ReadableStream, options?: { contentType?: string; length?: number }): Promise<void>;
export function s3Get(config: S3Config, key: string): Promise<Response>;
export function s3Delete(config: S3Config, key: string): Promise<void>;
export function s3Exists(config: S3Config, key: string): Promise<boolean>;
