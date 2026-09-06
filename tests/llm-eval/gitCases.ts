import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Git-tool preference cases.
//
// These cases verify that the agent uses purpose-built git_* tools rather
// than falling back to `run_command git …`. The Tool Preference rule in the
// system prompt says: "use git_* tools for git operations". These cases pin
// that the rule holds in practice.
//
// All three cases require a real git repo in the sandbox, set up via
// `setupCommands`. The sandbox materializes the files first; setup commands
// then initialize git, stage/commit the initial state, and optionally make
// additional changes so the agent sees a non-trivial working tree.
// ---------------------------------------------------------------------------

const GIT_INIT_CMDS = [
  'git init -b main',
  'git config user.email eval@sidecar.local',
  'git config user.name SideCarEval',
];

// Setup commands run through execSync, which uses cmd.exe on Windows, where
// single quotes are literal characters rather than grouping. `git commit -m
// 'initial commit'` arrived as two arguments and failed the whole run. Double
// quotes group in both cmd and POSIX shells.

export const GIT_CASES: AgentEvalCase[] = [
  {
    id: 'git-diff-not-run-command',
    description: 'Agent uses git_diff (not run_command git diff) to show unstaged changes',
    tags: ['git', 'tool-preference', 'trajectory'],
    workspace: {
      'src/math.ts': 'export function add(a: number, b: number): number {\n' + '  return a + b;\n' + '}\n',
    },
    setupCommands: [
      ...GIT_INIT_CMDS,
      'git add .',
      'git commit -m "initial commit"',
      // Modify the file after the initial commit so there is a real diff
      "node -e \"const fs=require('fs'); fs.appendFileSync('src/math.ts', '\\nexport function subtract(a: number, b: number): number {\\n  return a - b;\\n}\\n')\"",
    ],
    userMessage: 'Show me what changes have been made to the repository since the last commit.',
    expect: {
      toolsCalled: ['git_diff'],
      toolsNotCalled: [],
      // The run_command tool should not be used for this git operation
      // (checking for 'git diff' in the arguments via finalText is the
      // cleanest proxy — if the model used run_command it would have
      // called it with "git diff" arguments, but we check the tool
      // trajectory instead)
      finalTextContains: ['subtract'],
    },
    softExpect: {
      toolsNotCalled: ['run_command'],
    },
  },

  {
    id: 'git-status-not-run-command',
    description: 'Agent uses git_status (not run_command git status) to report working tree state',
    tags: ['git', 'tool-preference', 'trajectory'],
    workspace: {
      'src/utils.ts': 'export const VERSION = "1.0.0";\n',
      'src/helper.ts': 'export function noop() {}\n',
    },
    setupCommands: [
      ...GIT_INIT_CMDS,
      'git add src/utils.ts',
      'git commit -m "add utils"',
      // helper.ts is untracked; modify utils.ts so there is also a modified file
      "node -e \"const fs=require('fs'); fs.writeFileSync('src/utils.ts', 'export const VERSION = \\\"1.0.1\\\";\\n')\"",
    ],
    userMessage: 'What is the current git status of this repository?',
    expect: {
      toolsCalled: ['git_status'],
      // The answer should mention both the modified tracked file and the
      // untracked new file
      finalTextContains: ['utils.ts'],
    },
    softExpect: {
      toolsNotCalled: ['run_command'],
      finalTextContains: ['helper.ts'],
    },
  },

  {
    id: 'git-log-recent-commit',
    description: 'Agent uses git_log (not run_command git log) to retrieve recent commit history',
    tags: ['git', 'tool-preference', 'trajectory'],
    workspace: {
      'src/app.ts': 'export const APP_NAME = "sidecar";\n',
    },
    setupCommands: [
      ...GIT_INIT_CMDS,
      'git add .',
      'git commit -m "feat: initial app setup"',
      "node -e \"const fs=require('fs'); fs.appendFileSync('src/app.ts', 'export const VERSION = \\\"0.1.0\\\";\\n')\"",
      'git add .',
      'git commit -m "feat: add version constant"',
    ],
    userMessage: 'Show me the recent commit history for this repository.',
    expect: {
      toolsCalled: ['git_log'],
      // Both commit messages should surface in the final answer
      finalTextContains: ['initial app setup'],
    },
    softExpect: {
      toolsNotCalled: ['run_command'],
      finalTextContains: ['add version constant'],
    },
  },
];
