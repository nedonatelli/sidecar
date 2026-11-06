import type { DatabaseProvider, ConnectionProfile } from './provider.js';
import { SqliteProvider } from './sqliteProvider.js';
import { PostgresProvider } from './postgresProvider.js';
import { MysqlProvider } from './mysqlProvider.js';
import { DuckDbProvider } from './duckdbProvider.js';

interface ActiveConnection {
  profile: ConnectionProfile;
  provider: DatabaseProvider;
  /** What the connection was opened with; see connectionKey. */
  key: string;
}

/**
 * Everything a connection was opened with. A cached connection whose key no
 * longer matches -- the profile points elsewhere, flipped readOnly, or a
 * password was stored or cleared -- is closed and reopened.
 */
function connectionKey(profile: ConnectionProfile, password: string | undefined): string {
  const { dialect, filePath, host, port, database, user, readOnly } = profile;
  return JSON.stringify([dialect, filePath, host, port, database, user, readOnly !== false, password ?? null]);
}

export class ConnectionManager {
  private connections = new Map<string, ActiveConnection>();

  /**
   * Returns an existing connected provider for `profile.id` opened with the
   * same settings and password, or creates a new one, connects it, and caches
   * it. A cached connection opened with other settings is closed first.
   */
  async getOrConnect(profile: ConnectionProfile, password?: string): Promise<DatabaseProvider> {
    const key = connectionKey(profile, password);
    const existing = this.connections.get(profile.id);
    if (existing?.provider.isConnected() && existing.key === key) return existing.provider;
    if (existing) {
      this.connections.delete(profile.id);
      await existing.provider.disconnect().catch(() => undefined);
    }

    const provider = this.createProvider(profile.dialect);
    await provider.connect(profile, password);
    this.connections.set(profile.id, { profile, provider, key });
    return provider;
  }

  /** Disconnect and remove a specific connection by id. */
  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn) {
      await conn.provider.disconnect();
      this.connections.delete(id);
    }
  }

  /** Disconnect and remove all tracked connections. */
  async disconnectAll(): Promise<void> {
    for (const id of [...this.connections.keys()]) {
      await this.disconnect(id);
    }
  }

  /** Returns a snapshot of all tracked connections and their current state. */
  getStatus(): Array<{ id: string; name: string; dialect: string; connected: boolean }> {
    return [...this.connections.values()].map(({ profile, provider }) => ({
      id: profile.id,
      name: profile.name,
      dialect: profile.dialect,
      connected: provider.isConnected(),
    }));
  }

  private createProvider(dialect: ConnectionProfile['dialect']): DatabaseProvider {
    switch (dialect) {
      case 'sqlite':
        return new SqliteProvider();
      case 'postgres':
        return new PostgresProvider();
      case 'mysql':
        return new MysqlProvider();
      case 'duckdb':
        return new DuckDbProvider();
    }
  }
}

/** Process-wide singleton connection registry. */
export const connectionManager = new ConnectionManager();
