/**
 * The agent terminal in a real VS Code terminal running Git Bash (#422).
 *
 * Unit tests check the strings guardStdin builds; only a real terminal shows
 * whether shell integration reports a command's end. It didn't for the
 * two-line guard, so every command timed out with no output, `echo` included.
 * Windows only, and only where Git Bash is installed.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { AgentTerminalExecutor } from '../../terminal/agentExecutor.js';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

suite('Agent terminal on Git Bash', function () {
  this.timeout(120_000);
  let exec: AgentTerminalExecutor;

  suiteSetup(async function () {
    if (process.platform !== 'win32' || !fs.existsSync(GIT_BASH)) this.skip();
    await vscode.workspace
      .getConfiguration('terminal.integrated')
      .update('defaultProfile.windows', 'Git Bash', vscode.ConfigurationTarget.Global);
    for (let i = 0; i < 50 && !/bash\.exe$/i.test(vscode.env.shell); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(vscode.env.shell, /bash\.exe$/i, `default shell is ${vscode.env.shell}`);
    exec = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 15_000 });
  });

  suiteTeardown(async () => {
    exec?.dispose();
    await vscode.workspace
      .getConfiguration('terminal.integrated')
      .update('defaultProfile.windows', undefined, vscode.ConfigurationTarget.Global);
  });

  // A timed-out command reports exit 0 with `timedOut` set, so every check
  // asserts it finished before reading its exit code.
  const run = async (cmd: string, timeout = 20_000) => {
    const r = await exec.execute(cmd, { timeout });
    assert.ok(r, 'shell integration unavailable');
    assert.strictEqual(r.timedOut, false, `${JSON.stringify(cmd)} did not finish: ${r.stdout.trim()}`);
    return r;
  };

  test('an ordinary command reports exit 0 and its output', async () => {
    const r = await run('echo hello-422');
    assert.strictEqual(r.exitCode, 0);
    assert.match(r.stdout, /hello-422/);
  });

  test('a failing command reports its own exit code', async () => {
    assert.strictEqual((await run('false')).exitCode, 1);
    assert.strictEqual((await run('sh -c "exit 3"')).exitCode, 3);
  });

  test('a pipeline and a chain report exit 0', async () => {
    assert.match((await run('echo a b c | wc -w')).stdout, /3/);
    assert.strictEqual((await run('cd . && pwd')).exitCode, 0);
  });

  test('cat with no input returns instead of waiting for it', async () => {
    assert.strictEqual((await run('cat', 15_000)).exitCode, 0);
  });

  test('a command the guard leaves unwrapped still finishes', async () => {
    assert.match((await run('echo kept # a trailing comment')).stdout, /kept/);
  });

  test('2>nul does not create a nul file', async () => {
    const dir = vscode.workspace.workspaceFolders![0].uri.fsPath;
    assert.match((await run('ls no-such-file-422 2>nul; echo done')).stdout, /done/);
    assert.ok(!fs.readdirSync(dir).some((f) => f.toLowerCase() === 'nul'), 'a nul file was created');
  });

  test('two commands sent together both finish', async () => {
    const [a, b] = await Promise.all([run('sleep 2; echo first-422'), run('echo second-422')]);
    assert.match(a.stdout, /first-422/);
    assert.match(b.stdout, /second-422/);
  });
});
