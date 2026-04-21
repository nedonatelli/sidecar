import type { DatabaseProvider, ConnectionProfile } from './provider.js';
import { SqliteProvider } from './sqliteProvider.js';
import { PostgresProvider } from './postgresProvider.js';
import { MysqlProvider } from './mysqlProvider.js';
import { DuckDbProvider } from './duckdbProvider.js';

interface ActiveConnection {
  profile: ConnectionProfile;
  provider: DatabaseProvider;
}

export class ConnectionManager {
  private connections = new Map<string, ActiveConnection>();

  /**
   * Returns an existing connected provider for `profile.id`, or creates a
   * new one, connects it, and caches it.
   */
  async getOrConnect(profile: ConnectionProfile, password?: string): Promise<DatabaseProvider> {
    const existing = this.connections.get(profile.id);
    if (existing?.provider.isConnected()) return existing.provider;

    const provider = this.createProvider(profile.dialect);
    await provider.connect(profile, password);
    this.connections.set(profile.id, { profile, provider });
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
