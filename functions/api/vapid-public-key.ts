const NO_CACHE = { 'Cache-Control': 'no-store' };

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const enabled = context.env.NOTIFICATIONS_ENABLED === 'true';
  if (!enabled) {
    return Response.json({ enabled: false }, { headers: NO_CACHE });
  }
  return Response.json({ enabled: true, publicKey: context.env.VAPID_PUBLIC_KEY }, { headers: NO_CACHE });
};
