interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// Known push service domain suffixes
const ALLOWED_PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'push.services.mozilla.com', // covers updates.push.services.mozilla.com
  'push.apple.com',            // covers web.push.apple.com
  'notify.windows.com',
  'android.googleapis.com',    // legacy Chrome
];

function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_PUSH_HOST_SUFFIXES.some(suf => host === suf || host.endsWith(`.${suf}`));
}

export async function sendPushNotification(
  subscription: PushSubscription,
  payload: object,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<boolean> {
  try {
    // Validate endpoint to prevent SSRF
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      console.error('Push endpoint not allowed:', subscription.endpoint);
      return false;
    }

    const endpointUrl = new URL(subscription.endpoint);
    const vapidHeaders = await generateVapidHeaders(
      endpointUrl.origin,
      vapidPublicKey,
      vapidPrivateKey,
      vapidSubject
    );

    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await encryptPayload(
      payloadBytes,
      subscription.keys.p256dh,
      subscription.keys.auth
    );

    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': vapidHeaders.authorization,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
      },
      body: new Uint8Array(encrypted).buffer,
    });

    return response.ok || response.status === 201;
  } catch (err) {
    console.error('Push notification failed:', err);
    return false;
  }
}

async function generateVapidHeaders(
  audience: string,
  publicKey: string,
  privateKey: string,
  subject: string
): Promise<{ authorization: string }> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject
  };

  const unsignedToken =
    base64urlEncode(JSON.stringify(header)) + '.' +
    base64urlEncode(JSON.stringify(payload));

  const key = await importVapidPrivateKey(privateKey, publicKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const jwt = unsignedToken + '.' + base64urlEncode(new Uint8Array(signature));

  return {
    authorization: `vapid t=${jwt}, k=${publicKey}`,
  };
}

async function importVapidPrivateKey(privateKeyBase64: string, publicKeyBase64: string): Promise<CryptoKey> {
  const privateKeyBytes = base64urlDecode(privateKeyBase64);
  const publicKeyBytes = base64urlDecode(publicKeyBase64);

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64urlEncode(publicKeyBytes.slice(1, 33)),
    y: base64urlEncode(publicKeyBytes.slice(33, 65)),
    d: base64urlEncode(privateKeyBytes)
  };

  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function encryptPayload(
  payload: Uint8Array,
  p256dhKey: string,
  authSecret: string
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const subscriberPublicKey = await crypto.subtle.importKey(
    'raw',
    base64urlDecode(p256dhKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subscriberPublicKey },
    localKeyPair.privateKey,
    256
  );

  const localPublicKey = await crypto.subtle.exportKey('raw', localKeyPair.publicKey);
  const localPublicKeyBytes = new Uint8Array(localPublicKey);
  const authSecretBytes = base64urlDecode(authSecret);
  const p256dhBytes = base64urlDecode(p256dhKey);

  const ikm = await hkdf(
    new Uint8Array(sharedSecret),
    authSecretBytes,
    concatBuffers(
      new TextEncoder().encode('WebPush: info\0'),
      p256dhBytes,
      localPublicKeyBytes
    ),
    32
  );

  const cek = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const paddedPayload = concatBuffers(payload, new Uint8Array([0x02]));

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    paddedPayload
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);

  return concatBuffers(
    salt,
    recordSize,
    new Uint8Array([65]),
    localPublicKeyBytes,
    new Uint8Array(encrypted)
  );
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8
  );
  return new Uint8Array(derived);
}

function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    result.set(buffer, offset);
    offset += buffer.length;
  }
  return result;
}

function base64urlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
