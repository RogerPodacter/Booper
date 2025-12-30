import { getSecret, revealSecret, getLocationFromCF } from '../../../_shared/kv';
import { sendPushNotification } from '../../../_shared/push';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const kv = context.env.BOOP_KV;
  const id = context.params.id as string;

  const secret = await getSecret(kv, id);

  if (!secret) {
    return Response.json(
      { error: "This secret doesn't exist." },
      { status: 404 }
    );
  }

  if (secret.revealed) {
    return Response.json(
      { error: 'This secret has already been opened.' },
      { status: 410 }
    );
  }

  // TTL handles expiry - if we get here, secret is valid
  const result = await revealSecret(kv, id);

  if (!result.success) {
    return Response.json(
      { error: 'This secret has already been opened.' },
      { status: 410 }
    );
  }

  // Send push notification if enabled and subscription exists
  if (context.env.NOTIFICATIONS_ENABLED === 'true' && secret.push_subscription) {
    try {
      const location = getLocationFromCF(context.request.cf);
      const subscription = JSON.parse(secret.push_subscription);
      await sendPushNotification(
        subscription,
        { title: 'Your boop was opened!', body: `Opened near ${location}` },
        context.env.VAPID_PUBLIC_KEY,
        context.env.VAPID_PRIVATE_KEY,
        context.env.VAPID_SUBJECT
      );
    } catch (err) {
      console.error('Push notification error:', err);
    }
  }

  return Response.json({
    encryptedContent: result.content
  });
};
