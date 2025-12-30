interface Env {
  BOOP_KV: KVNamespace;
  NOTIFICATIONS_ENABLED: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

type PagesFunction<E = Env> = import("@cloudflare/workers-types").PagesFunction<E>;
type HTMLRewriterElement = import("@cloudflare/workers-types").Element;
type HTMLRewriter = import("@cloudflare/workers-types").HTMLRewriter;
declare const HTMLRewriter: {
  new (): HTMLRewriter;
};
