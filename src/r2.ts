import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

export function r2EndpointUrl(accountId: string): string {
  if (!accountId) throw new Error('R2 account id is required');
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function buildSubstituterUrl(bucket: string, accountId: string): string {
  if (!bucket) throw new Error('R2 bucket is required');
  const endpoint = r2EndpointUrl(accountId);
  return `s3://${bucket}?endpoint=${endpoint}&region=auto`;
}

export interface R2Credentials {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export async function smokeTestBucket(creds: R2Credentials): Promise<void> {
  const client = new S3Client({
    region: 'auto',
    endpoint: r2EndpointUrl(creds.accountId),
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: true,
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: creds.bucket }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`R2 bucket "${creds.bucket}" not reachable: ${msg}`);
  } finally {
    client.destroy();
  }
}
