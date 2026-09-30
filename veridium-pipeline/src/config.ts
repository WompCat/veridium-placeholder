import 'dotenv/config';

export const config = {
  riotApiKey: process.env.RIOT_API_KEY ?? '',
  port: Number(process.env.PORT || 4000),
  dbPath: process.env.DB_PATH || './data/veridium.db',
  matchWindow: Number(process.env.MATCH_WINDOW || 20),
};
