import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';

/**
 * DuckDB is opt-in. Its engine, `@duckdb/node-api`, is a native module of
 * about 40 MB per platform, so the .vsix doesn't ship it (#364). A user who
 * wants DuckDB installs it with "SideCar: Install DuckDB Engine", which runs npm
 * into SideCar's own storage folder.
 *
 * A user who already has the Node package elsewhere points
 * `sidecar.databases.duckdbPath` at it. That setting is machine-scoped, and the
 * open project is never searched on its own: a cloned repo could otherwise
 * ship a `node_modules/@duckdb/node-api` of its own and have it run on the
 * first DuckDB query.
 *
 * The binding is Node-API, which is ABI-stable, so a copy built by the user's
 * own npm loads in VS Code's extension host.
 */

const MODULE = '@duckdb/node-api';

/** What the install command fetches: the version the provider is tested against. */
export const DUCKDB_ENGINE_PACKAGE = `${MODULE}@1.5.2-r.1`;

export const DUCKDB_MISSING_MESSAGE =
  'DuckDB is not installed. Run "SideCar: Install DuckDB Engine" to install it (npm downloads @duckdb/node-api, ' +
  "about 40 MB, into SideCar's storage), or point sidecar.databases.duckdbPath at an existing install.";

let engineDir: string | null = null;
let configuredPath: () => string | undefined = () => undefined;

/**
 * Called once at activation: where the install command puts the engine, and a
 * reader for the `sidecar.databases.duckdbPath` setting.
 */
export function configureDuckDbEngine(opts: { engineDir: string; configuredPath: () => string | undefined }): void {
  engineDir = opts.engineDir;
  configuredPath = opts.configuredPath;
}

export function duckDbEngineDir(): string | null {
  return engineDir;
}

export function isDuckDbEngineInstalled(dir: string | null = engineDir): boolean {
  return !!dir && fs.existsSync(path.join(dir, 'node_modules', ...MODULE.split('/'), 'package.json'));
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (e?.code === 'MODULE_NOT_FOUND' || e?.code === 'ERR_MODULE_NOT_FOUND') && String(e.message).includes(MODULE);
}

/** The package folder itself (its package.json names the module), or undefined. */
function asPackageDir(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
    return pkg.name === MODULE ? dir : undefined;
  } catch {
    return undefined;
  }
}

function requireFrom(location: string): unknown {
  const pkgDir = asPackageDir(location);
  const req = createRequire(path.join(location, 'package.json'));
  return pkgDir ? req(pkgDir) : req(MODULE);
}

/**
 * Load the DuckDB module, from (in order) the `sidecar.databases.duckdbPath`
 * setting, SideCar's own install, and the extension's own modules (a dev
 * checkout has it as a devDependency). A copy that is found but fails to load
 * -- wrong platform, a broken install -- reports its own error rather than
 * "not installed". A configured path that holds no DuckDB says so.
 */
export async function loadDuckDb<T>(): Promise<T> {
  const configured = configuredPath();
  if (configured) {
    try {
      return requireFrom(configured) as T;
    } catch (err) {
      if (isNotFound(err)) {
        throw new Error(
          `sidecar.databases.duckdbPath is "${configured}", but no @duckdb/node-api was found there. Point it at the ` +
            'package folder, or at a folder whose node_modules contains it.',
        );
      }
      throw new Error(`DuckDB at ${configured} failed to load: ${String(err)}`);
    }
  }
  if (engineDir) {
    try {
      return requireFrom(engineDir) as T;
    } catch (err) {
      if (!isNotFound(err)) throw new Error(`DuckDB under ${engineDir} failed to load: ${String(err)}`);
    }
  }
  try {
    return (await import('@duckdb/node-api')) as T;
  } catch (err) {
    if (isNotFound(err)) throw new Error(DUCKDB_MISSING_MESSAGE);
    throw new Error(`DuckDB failed to load: ${String(err)}`);
  }
}

export interface NpmRun {
  code: number | null;
  output: string;
}

/** Runs npm with fixed arguments in `cwd`. Replaceable in tests. */
export type NpmRunner = (args: string[], cwd: string) => Promise<NpmRun>;

const runNpm: NpmRunner = (args, cwd) =>
  new Promise((resolve) => {
    // npm is npm.cmd on Windows, which needs a shell. The arguments are fixed
    // strings from this module, never user input.
    const child = spawn('npm', args, { cwd, shell: process.platform === 'win32', windowsHide: true });
    let output = '';
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));
    child.on('error', (err) => resolve({ code: null, output: output + String(err) }));
    child.on('close', (code) => resolve({ code, output }));
  });

/** Install the engine into `dir` with npm. Throws with npm's output when it fails. */
export async function installDuckDbEngine(dir: string, run: NpmRunner = runNpm): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ name: 'sidecar-duckdb-engine', private: true }, null, 2) + '\n');
  }
  const result = await run(['install', '--no-audit', '--no-fund', '--omit=dev', DUCKDB_ENGINE_PACKAGE], dir);
  if (result.code !== 0 || !isDuckDbEngineInstalled(dir)) {
    const tail = result.output.trim().split(/\r?\n/).slice(-8).join('\n');
    throw new Error(
      result.code === null
        ? `npm could not be started. Install Node.js (which includes npm) and try again.\n${tail}`
        : `npm install failed (exit ${result.code}).\n${tail}`,
    );
  }
}

/** Remove the engine SideCar installed. */
export function removeDuckDbEngine(dir: string): void {
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });
}
