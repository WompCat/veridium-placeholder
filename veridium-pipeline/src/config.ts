import 'dotenv/config';

export const config = {
  riotApiKey: process.env.RIOT_API_KEY ?? '',
  // Hosts inject PORT; 4000 is only the local default. 0.0.0.0 so the host can route outside traffic in.
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  // When set, every page and API route (except /api/health) requires this password (HTTP Basic auth).
  sitePassword: process.env.SITE_PASSWORD || '',
  dbPath: process.env.DB_PATH || './data/veridium.db',
  // Seasons (TFT sets) to keep full history for: the current one plus SEASONS - 1 previous.
  seasons: Number(process.env.SEASONS || 3),
};
