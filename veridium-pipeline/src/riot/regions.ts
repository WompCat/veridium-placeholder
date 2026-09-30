export type RegionalRoute = 'americas' | 'europe' | 'asia' | 'sea';

// Platform routing value -> regional routing value (for account-v1 and tft-match-v1).
export const PLATFORM_TO_REGIONAL: Record<string, RegionalRoute> = {
  na1: 'americas',
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  euw1: 'europe',
  eun1: 'europe',
  tr1: 'europe',
  ru: 'europe',
  me1: 'europe',
  kr: 'asia',
  jp1: 'asia',
  oc1: 'sea',
  sg2: 'sea',
  tw2: 'sea',
  vn2: 'sea',
};

export function isPlatform(platform: string): boolean {
  return platform.toLowerCase() in PLATFORM_TO_REGIONAL;
}

export function regionalFor(platform: string): RegionalRoute {
  const regional = PLATFORM_TO_REGIONAL[platform.toLowerCase()];
  if (!regional) throw new Error(`Unknown platform region: ${platform}`);
  return regional;
}

export function hostFor(route: string): string {
  return `https://${route.toLowerCase()}.api.riotgames.com`;
}
