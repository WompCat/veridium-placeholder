import { config } from './config';

/**
 * The current Terms of Service + Privacy Policy. Bump the version (and the date shown on
 * public/terms.html and public/privacy.html) whenever either changes materially: every account
 * is then asked to accept again before it can do anything that needs a login.
 */
// .2: minimum age 16; orgs handle consent for players under 18. .3: the under-18 application flag.
export const TERMS_VERSION = '2026-10-11'; // 2026-10-11: player search, follows, notifications, team history, org verification

export const legalInfo = () => ({
  termsVersion: TERMS_VERSION,
  contactEmail: config.contactEmail || null,
});
