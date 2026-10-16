/** The portal's brand, written into its HTML shell. */

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The portal shell with the operator's name, logo and favicon written in.
 *
 * Done on the server rather than fetched by the page, because the tab title and
 * the favicon are read before any script runs — a portal that loaded its brand
 * from an API would flash the PartnerDex mark at every affiliate first. The logo
 * travels as a `<meta>` the page reads on mount. Every value is configuration,
 * checked at startup, and escaped here all the same.
 *
 * Its own module, with no imports, so `vite.config.ts` can apply the same
 * rewrite to the dev server's copy of the page.
 */
export function brandPortalHtml(
  html: string,
  brand: { name: string; logoUrl: string; faviconUrl: string },
): string {
  let out = html;
  if (brand.name) {
    out = out.replace(
      /<title>[^<]*<\/title>/,
      `<title>${escapeAttribute(brand.name)} affiliate portal</title>`,
    );
  }
  if (brand.faviconUrl) {
    out = out.replace(
      /<link rel="icon"[^>]*>/,
      `<link rel="icon" href="${escapeAttribute(brand.faviconUrl)}" />`,
    );
  }
  const meta = [
    brand.name ? `<meta name="portal-brand-name" content="${escapeAttribute(brand.name)}" />` : '',
    brand.logoUrl
      ? `<meta name="portal-brand-logo" content="${escapeAttribute(brand.logoUrl)}" />`
      : '',
  ].join('');
  return meta ? out.replace('</head>', `${meta}</head>`) : out;
}
