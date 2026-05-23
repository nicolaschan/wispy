#!/usr/bin/env node
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { execFileSync } from 'node:child_process';

const bucket = process.env.WISPY_R2_BUCKET;
const accountId = process.env.WISPY_R2_ACCOUNT_ID;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const outPath = process.argv[2];

if (!outPath) {
  console.error('usage: check-pushed.mjs <store-path>');
  process.exit(2);
}

const hashPart = outPath.split('/').pop().split('-')[0];
const narinfoKey = `${hashPart}.narinfo`;

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
});

try {
  await client.send(new HeadObjectCommand({ Bucket: bucket, Key: narinfoKey }));
  console.log(`OK: ${narinfoKey} exists in ${bucket}`);
} catch (err) {
  console.error(`FAIL: ${narinfoKey} not found in ${bucket}: ${err.message}`);
  // Dump a directory listing to aid debugging.
  try {
    execFileSync('nix', ['path-info', outPath], { stdio: 'inherit' });
  } catch {}
  process.exit(1);
} finally {
  client.destroy();
}
