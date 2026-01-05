import { getSecret } from '../../../_shared/kv';

const NO_CACHE = { 'Cache-Control': 'no-store' };

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const kv = context.env.BOOP_KV;
  const id = context.params.id as string;

  const secret = await getSecret(kv, id);

  if (!secret) {
    return Response.json(
      { error: "This secret doesn't exist.", status: 'not_found' },
      { status: 404, headers: NO_CACHE }
    );
  }

  if (secret.revealed) {
    return Response.json({ status: 'revealed' }, { headers: NO_CACHE });
  }

  // Backwards compatibility: treat missing values as single-view
  const maxViews = secret.max_views ?? 1;
  const viewCount = secret.view_count ?? 0;

  // Return encrypted metadata - client decrypts to get type/duration
  return Response.json({
    status: 'pending',
    encryptedMeta: secret.encrypted_meta,
    maxViews,
    viewCount,
    viewsRemaining: maxViews - viewCount
  }, { headers: NO_CACHE });
};
