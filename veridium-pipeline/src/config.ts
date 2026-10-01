import 'dotenv/config';

export const config = {
  riotApiKey: process.env.RIOT_API_KEY ?? '',
  port: Number(process.env.PORT || 4000),
  dbPath: process.env.DB_PATH || './data/veridium.db',
  // Seasons (TFT sets) to keep full history for: the current one plus SEASONS - 1 previous.
  seasons: Number(process.env.SEASONS || 3),
};
