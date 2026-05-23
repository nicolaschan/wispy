export interface CacheInfo {
  storeDir: string;
  priority: number;
  wantMassQuery: boolean;
  // The cache's signing public key, in Nix format `<name>:<base64>`. This
  // is a wispy-specific extension to nix-cache-info (Nix ignores unknown
  // keys), encoded by setup.mjs so consumers can discover the pubkey
  // without a separate input.
  publicKey: string;
}

export function parseCacheInfo(text: string): CacheInfo {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!fields['StoreDir']) throw new Error('nix-cache-info missing StoreDir');
  if (!fields['Wispy-PublicKey']) throw new Error('nix-cache-info missing Wispy-PublicKey');
  return {
    storeDir: fields['StoreDir'],
    priority: Number.parseInt(fields['Priority'] ?? '50', 10),
    wantMassQuery: fields['WantMassQuery'] === '1',
    publicKey: fields['Wispy-PublicKey'],
  };
}

export async function fetchCacheInfo(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<CacheInfo> {
  const res = await fetchImpl(`${serverUrl}/nix-cache-info`);
  if (!res.ok) {
    throw new Error(`GET /nix-cache-info → ${res.status} ${res.statusText}`);
  }
  return parseCacheInfo(await res.text());
}
