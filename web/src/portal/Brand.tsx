import { Logo } from '../components/Logo';

/**
 * The operator's identity on the portal, as the server wrote it into the page.
 *
 * Read from `<meta>` tags rather than an API: the server already has to rewrite
 * the shell for the tab title and favicon (see `brandPortalHtml`), and a second
 * round trip would show the default mark first and swap it a moment later.
 * Absent tags — the Vite dev server, or an install that configured nothing —
 * mean the PartnerDex defaults.
 */
function meta(name: string): string {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim() ?? '';
}

export const portalBrandName = meta('portal-brand-name');
const logoUrl = meta('portal-brand-logo');

/** The configured logo, or the P mark. Decorative: the heading beside it names the page. */
export function PortalLogo() {
  if (!logoUrl) return <Logo />;
  return <img className="brand-mark brand-image" src={logoUrl} alt="" />;
}
