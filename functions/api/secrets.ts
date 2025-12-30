import { createSecret, checkRateLimit } from '../_shared/kv';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const kv = context.env.BOOP_KV;
  const ip = context.request.headers.get('cf-connecting-ip') || 'unknown';

  const allowed = await checkRateLimit(kv, ip);
  if (!allowed) {
    return Response.json(
      { error: 'Too many secrets. Try again later.' },
      { status: 429 }
    );
  }

  let body: {
    id?: string;
    encryptedMeta?: string;
    encryptedContent?: string;
    pushSubscription?: unknown;
  };

  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { id, encryptedMeta, encryptedContent, pushSubscription } = body;

  if (!id || !encryptedMeta || !encryptedContent) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Type validation
  if (typeof id !== 'string' || typeof encryptedMeta !== 'string' || typeof encryptedContent !== 'string') {
    return Response.json({ error: 'Invalid field types' }, { status: 400 });
  }

  if (!/^[A-Za-z0-9]{6,12}$/.test(id)) {
    return Response.json({ error: 'Invalid ID format' }, { status: 400 });
  }

  // Size checks
  if (encryptedMeta.length > 10 * 1024) { // 10KB max for metadata
    return Response.json({ error: 'Metadata exceeds size limit.' }, { status: 400 });
  }
  if (encryptedContent.length > 2.5 * 1024 * 1024) {
    return Response.json({ error: 'Content exceeds size limit.' }, { status: 400 });
  }
  const pushSubscriptionStr = pushSubscription ? JSON.stringify(pushSubscription) : null;
  if (pushSubscriptionStr && pushSubscriptionStr.length > 4 * 1024) { // 4KB max
    return Response.json({ error: 'Push subscription exceeds size limit.' }, { status: 400 });
  }

  try {
    const result = await createSecret(kv, {
      id,
      encrypted_meta: encryptedMeta,
      encrypted_content: encryptedContent,
      push_subscription: pushSubscriptionStr
    });

    if (!result.success) {
      return Response.json({ error: 'ID collision' }, { status: 409 });
    }

    return Response.json({ id });
  } catch (error) {
    console.error('Error creating secret:', error);
    return Response.json({ error: 'Failed to create secret' }, { status: 500 });
  }
};
