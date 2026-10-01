// Usage: npm run seed  (creates the Obscurity Esports org record if it doesn't exist yet)
import { Store } from './cache/store';
import { config } from './config';
import { OrgRepo } from './orgs/repo';

const SEED_ORGS = [{ id: 'obscurity-esports', name: 'Obscurity Esports' }];

const store = new Store(config.dbPath);
try {
  const orgs = new OrgRepo(store.db);
  for (const { id, name } of SEED_ORGS) {
    if (orgs.getOrganization(id)) {
      console.log(`${name} already exists (${id})`);
    } else {
      orgs.createOrganization(name, id);
      console.log(`Created ${name} (${id})`);
    }
  }
} finally {
  store.close();
}
