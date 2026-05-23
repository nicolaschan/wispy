export interface Narinfo {
  storePath: string;
  url: string;
  compression: string;
  fileHash: string;
  fileSize: number;
  narHash: string;
  narSize: number;
  references: string[];
  deriver?: string;
  sig?: string;
}

const REQUIRED = ['StorePath', 'URL', 'Compression', 'FileHash', 'FileSize', 'NarHash', 'NarSize'] as const;

export function parseNarinfo(text: string): Narinfo {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fields[key] = value;
  }
  for (const k of REQUIRED) {
    if (!(k in fields)) throw new Error(`narinfo missing required field: ${k}`);
  }
  const refsRaw = fields['References'] ?? '';
  const references = refsRaw.length === 0 ? [] : refsRaw.split(/\s+/).filter(Boolean);
  return {
    storePath: fields['StorePath']!,
    url: fields['URL']!,
    compression: fields['Compression']!,
    fileHash: fields['FileHash']!,
    fileSize: Number.parseInt(fields['FileSize']!, 10),
    narHash: fields['NarHash']!,
    narSize: Number.parseInt(fields['NarSize']!, 10),
    references,
    deriver: fields['Deriver'],
    sig: fields['Sig'],
  };
}

export function serializeNarinfo(n: Narinfo): string {
  const lines = [
    `StorePath: ${n.storePath}`,
    `URL: ${n.url}`,
    `Compression: ${n.compression}`,
    `FileHash: ${n.fileHash}`,
    `FileSize: ${n.fileSize}`,
    `NarHash: ${n.narHash}`,
    `NarSize: ${n.narSize}`,
    `References: ${n.references.join(' ')}`,
  ];
  if (n.deriver !== undefined) lines.push(`Deriver: ${n.deriver}`);
  if (n.sig !== undefined) lines.push(`Sig: ${n.sig}`);
  return lines.join('\n') + '\n';
}

// Fingerprint formula from Nix source (libstore/path-info.cc): the bytes that
// the signature must cover. References are joined by comma, prefixed with the
// store directory to form full store paths.
export function fingerprint(n: Narinfo, storeDir: string): string {
  const refs = n.references.map((r) => `${storeDir}/${r}`).join(',');
  return `1;${n.storePath};${n.narHash};${n.narSize};${refs}`;
}
