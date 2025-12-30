class MetaRewriter {
  constructor(private imageUrl: string) {}

  element(element: HTMLRewriterElement) {
    const property = element.getAttribute('property');
    const name = element.getAttribute('name');

    if (property === 'og:title' || name === 'twitter:title') {
      element.setAttribute('content', 'Someone sent you a boop');
    } else if (property === 'og:description' || name === 'twitter:description') {
      element.setAttribute('content', 'Tap to reveal');
    } else if (property === 'og:image' || name === 'twitter:image') {
      element.setAttribute('content', this.imageUrl);
    }
  }
}

class TitleRewriter {
  element(element: HTMLRewriterElement) {
    element.setInnerContent('Someone sent you a boop');
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const method = context.request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return context.next();
  }

  const response = await context.next();

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/html')) {
    return response;
  }

  const imageUrl = new URL('/og-boop.png', context.request.url).toString();

  return new HTMLRewriter()
    .on('meta[property^="og:"], meta[name^="twitter:"]', new MetaRewriter(imageUrl))
    .on('title', new TitleRewriter())
    .transform(response);
};
