class ImageRewriter {
  constructor(private imageUrl: string) {}

  element(element: HTMLRewriterElement) {
    const property = element.getAttribute('property');
    const name = element.getAttribute('name');

    if (property === 'og:image' || name === 'twitter:image') {
      element.setAttribute('content', this.imageUrl);
    }
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

  const imageUrl = new URL('/og-home.png', context.request.url).toString();

  return new HTMLRewriter()
    .on('meta[property="og:image"], meta[name="twitter:image"]', new ImageRewriter(imageUrl))
    .transform(response);
};
