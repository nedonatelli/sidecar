export type ContextProviderType = 'github' | 'linear' | 'jira';

export type ContextProviderFilter = 'assigned' | 'open' | 'recent';

export interface ContextProviderConfig {
  type: ContextProviderType;
  /** PAT or API key. Stored in settings (same trade-off as sidecar.webSearch.apiKey). */
  token: string;
  /** GitHub Enterprise or Jira base URL. For github.com and Linear, leave empty. */
  baseUrl?: string;
  /** GitHub: "owner/repo" — auto-detected from git remote when empty.
   *  Jira: project key (e.g. "MYPROJ") — fetches all projects when empty. */
  project?: string;
  /** Which issues to surface. Default: "assigned". */
  filter: ContextProviderFilter;
  /** Max issues to inject per provider. Default: 5. */
  maxIssues: number;
}

export interface ContextIssue {
  /** Human-readable ID: "#123", "SC-456", "PROJ-789" */
  id: string;
  title: string;
  status: string;
  /** Truncated body / description. */
  body?: string;
  url?: string;
  labels?: string[];
  priority?: string;
  updatedAt?: string;
}

export interface ContextProviderResult {
  /** Label shown in the prompt heading, e.g. "GitHub (owner/repo)" */
  providerLabel: string;
  issues: ContextIssue[];
  /** Set when the fetch failed — shown as a warning line, not a hard error. */
  error?: string;
}
