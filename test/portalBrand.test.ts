import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brandPortalHtml } from '../src/server/portalBrand.js';

const SHELL =
  '<html><head><title>Affiliate portal — PartnerDex</title>' +
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg" /></head><body></body></html>';

describe('portal branding', () => {
  it('leaves the shell alone when nothing is configured', () => {
    assert.equal(brandPortalHtml(SHELL, { name: '', logoUrl: '', faviconUrl: '' }), SHELL);
  });

  it('writes the name, favicon and logo into the shell', () => {
    const html = brandPortalHtml(SHELL, {
      name: 'AIOD',
      logoUrl: 'https://example.com/logo.png',
      faviconUrl: 'https://example.com/favicon.ico',
    });
    assert.match(html, /<title>AIOD affiliate portal<\/title>/);
    assert.match(html, /<link rel="icon" href="https:\/\/example.com\/favicon.ico" \/>/);
    assert.ok(!html.includes('/favicon.svg'));
    assert.match(html, /<meta name="portal-brand-logo" content="https:\/\/example.com\/logo.png" \/>/);
    assert.match(html, /<meta name="portal-brand-name" content="AIOD" \/>/);
  });

  it('escapes what it writes', () => {
    const html = brandPortalHtml(SHELL, { name: '"><script>x</script>', logoUrl: '', faviconUrl: '' });
    assert.ok(!html.includes('<script>x'));
  });
});
