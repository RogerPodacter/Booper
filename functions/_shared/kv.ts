export interface Secret {
  id: string;
  encrypted_meta: string;     // { type, duration } - returned by status
  encrypted_content: string;  // actual photo/video - returned by reveal
  revealed: boolean;
  push_subscription: string | null;
}

export async function createSecret(
  kv: KVNamespace,
  secret: Omit<Secret, 'revealed'>
): Promise<{ success: boolean }> {
  // Check if ID already exists
  const existing = await kv.get(`secret:${secret.id}`);
  if (existing) {
    return { success: false };
  }

  const data: Secret = {
    ...secret,
    revealed: false
  };

  await kv.put(`secret:${secret.id}`, JSON.stringify(data), {
    expirationTtl: 7 * 24 * 60 * 60 // 7 days
  });

  return { success: true };
}

export async function getSecret(kv: KVNamespace, id: string): Promise<Secret | null> {
  const raw = await kv.get(`secret:${id}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Secret;
  } catch {
    return null;
  }
}

export async function revealSecret(
  kv: KVNamespace,
  id: string
): Promise<{ success: boolean; content?: string }> {
  const secret = await getSecret(kv, id);
  if (!secret || secret.revealed) {
    return { success: false };
  }

  const content = secret.encrypted_content;

  // Replace with minimal "revealed" tombstone
  await kv.put(`secret:${id}`, JSON.stringify({ revealed: true }), {
    expirationTtl: 48 * 60 * 60
  });

  return { success: true, content };
}

const RATE_LIMIT_SALT = 'booper-rl-2025';

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip + RATE_LIMIT_SALT);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}

export async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const ipHash = await hashIP(ip);
  const key = `ratelimit:${ipHash}`;
  const raw = await kv.get(key);

  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  let requests: number[] = [];
  if (raw) {
    try {
      requests = JSON.parse(raw).filter((t: number) => t > hourAgo);
    } catch {
      requests = [];
    }
  }

  if (requests.length >= 50) {
    return false;
  }

  requests.push(now);
  await kv.put(key, JSON.stringify(requests), {
    expirationTtl: 60 * 60 // 1 hour
  });

  return true;
}

export function getLocationFromCF(cf: CfProperties | undefined): string {
  if (!cf) return 'Unknown location';

  const city = cf.city as string | undefined;
  const country = cf.country as string | undefined;

  if (city && country) {
    return `${city}, ${country}`;
  }
  return country || 'Unknown location';
}
