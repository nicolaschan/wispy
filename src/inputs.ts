export interface RawInputs {
  'server-url': string;
  token: string;
}

export interface Inputs {
  serverUrl: string;
  token: string;
}

export function parseInputs(raw: RawInputs): Inputs {
  const serverUrl = (raw['server-url'] ?? '').trim();
  const token = (raw.token ?? '').trim();
  if (!serverUrl) throw new Error('input "server-url" is required');
  if (!token) throw new Error('input "token" is required');
  if (!serverUrl.startsWith('https://')) {
    throw new Error('"server-url" must use https');
  }
  return {
    serverUrl: serverUrl.replace(/\/+$/, ''),
    token,
  };
}
