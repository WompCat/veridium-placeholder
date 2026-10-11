import type Database from 'better-sqlite3';

export type FollowTarget = 'player' | 'org';

/** Who an account follows. Lists are private to that account; others only see counts. */
export class FollowRepo {
  constructor(
    private db: Database.Database,
    private now: () => Date = () => new Date(),
  ) {}

  follow(userId: string, type: FollowTarget, id: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO follows (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, type, id, this.now().toISOString());
  }

  unfollow(userId: string, type: FollowTarget, id: string) {
    this.db.prepare('DELETE FROM follows WHERE user_id = ? AND target_type = ? AND target_id = ?').run(userId, type, id);
  }

  followers(type: FollowTarget, id: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM follows WHERE target_type = ? AND target_id = ?').get(type, id) as { n: number }).n;
  }

  isFollowing(userId: string, type: FollowTarget, id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM follows WHERE user_id = ? AND target_type = ? AND target_id = ?').get(userId, type, id);
  }

  following(userId: string): { players: Set<string>; orgs: Set<string> } {
    const rows = this.db.prepare('SELECT target_type, target_id FROM follows WHERE user_id = ?').all(userId) as Array<{ target_type: FollowTarget; target_id: string }>;
    return {
      players: new Set(rows.filter((r) => r.target_type === 'player').map((r) => r.target_id)),
      orgs: new Set(rows.filter((r) => r.target_type === 'org').map((r) => r.target_id)),
    };
  }

  /** Forget a deleted org (or player) so it doesn't linger in anyone's follows. */
  removeTarget(type: FollowTarget, id: string) {
    this.db.prepare('DELETE FROM follows WHERE target_type = ? AND target_id = ?').run(type, id);
  }
}
