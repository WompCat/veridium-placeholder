import 'dotenv/config';

export const config = {
  riotApiKey: process.env.RIOT_API_KEY ?? '',
  // Hosts inject PORT; 4000 is only the local default. 0.0.0.0 so the host can route outside traffic in.
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  // When set, every page and API route (except /api/health) requires this password (HTTP Basic auth).
  sitePassword: process.env.SITE_PASSWORD || '',
  dbPath: process.env.DB_PATH || './data/veridium.db',
  // Shown on the Privacy Policy and Terms as the address for privacy and account requests.
  contactEmail: process.env.CONTACT_EMAIL || '',
  // Veridium's own staff (comma-separated emails): they can verify organizations.
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  // Email notifications through Brevo: off unless both are set. EMAIL_FROM must be a sender verified
  // in Brevo, e.g. "Veridium <noreply@yourdomain>".
  brevoApiKey: process.env.BREVO_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || '',
  // The site's public address (e.g. https://veridium.gg), for links in emails.
  siteUrl: process.env.SITE_URL || '',
  // Seasons (TFT sets) to keep full history for: the current one plus SEASONS - 1 previous.
  seasons: Number(process.env.SEASONS || 3),
};
