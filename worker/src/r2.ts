// Minimal interface over R2 we depend on. Lets index.ts be tested with a
// fake without pulling in the full Workers runtime.
export interface R2Like {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; httpEtag: string } | null>;
  head(key: string): Promise<{ httpEtag: string } | null>;
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | string): Promise<{ key: string }>;
}

// The actual Workers R2Bucket binding satisfies this shape modulo extras.
export function r2FromBinding(bucket: R2Bucket): R2Like {
  return {
    async get(key) {
      const obj = await bucket.get(key);
      if (obj === null) return null;
      return { body: obj.body, httpEtag: obj.httpEtag };
    },
    async head(key) {
      const obj = await bucket.head(key);
      if (obj === null) return null;
      return { httpEtag: obj.httpEtag };
    },
    async put(key, value) {
      const obj = await bucket.put(key, value as ReadableStream<Uint8Array>);
      if (obj === null) throw new Error(`R2 put returned null for key ${key}`);
      return { key: obj.key };
    },
  };
}
