import { config } from './config';

/**
 * The current Terms of Service + Privacy Policy. Bump the version (and the date shown on
 * public/terms.html and public/privacy.html) whenever either changes materially: every account
 * is then asked to accept again before it can do anything that needs a login.
 */
export const TERMS_VERSION = '2026-10-10';

export const legalInfo = () => ({
  termsVersion: TERMS_VERSION,
  contactEmail: config.contactEmail || null,
});
