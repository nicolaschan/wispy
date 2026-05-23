export function r2EndpointUrl(accountId: string): string {
  if (!accountId) throw new Error('R2 account id is required');
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function buildSubstituterUrl(bucket: string, accountId: string): string {
  if (!bucket) throw new Error('R2 bucket is required');
  const endpoint = r2EndpointUrl(accountId);
  return `s3://${bucket}?endpoint=${endpoint}&region=auto`;
}
