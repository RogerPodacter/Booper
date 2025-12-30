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

  // Return encrypted metadata - client decrypts to get type/duration
  return Response.json({
    status: 'pending',
    encryptedMeta: secret.encrypted_meta
  }, { headers: NO_CACHE });
};
