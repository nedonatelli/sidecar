import type { ContextProviderConfig, ContextProviderResult, ContextIssue } from '../types.js';
import { stripTrailingSlash } from '../../util/url.js';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    description?: { content?: Array<{ content?: Array<{ text?: string }> }> } | null;
    assignee?: { emailAddress?: string; displayName?: string } | null;
    priority?: { name: string } | null;
    labels?: string[];
    updated?: string;
    issuetype?: { name: string };
  };
}

/** Extract plain text from Jira's Atlassian Document Format body. Best-effort. */
function extractJiraText(doc: JiraIssue['fields']['description']): string {
  if (!doc?.content) return '';
  const parts: string[] = [];
  for (const block of doc.content) {
    for (const inline of block.content ?? []) {
      if (inline.text) parts.push(inline.text);
    }
  }
  const text = parts.join(' ').trim();
  return text.length > 400 ? text.slice(0, 400) + '…' : text;
}

export async function fetchJiraIssues(
  config: ContextProviderConfig,
  fetchFn: typeof fetch = fetch,
): Promise<ContextProviderResult> {
  const base = config.baseUrl ? stripTrailingSlash(config.baseUrl) : undefined;
  const host = base ? new URL(base).hostname : 'jira';
  const providerLabel = `Jira (${host})`;

  if (!base) {
    return {
      providerLabel,
      issues: [],
      error: 'No baseUrl configured. Set sidecar.contextProviders[].baseUrl to your Jira instance URL.',
    };
  }
  if (!config.token) {
    return { providerLabel, issues: [], error: 'No token configured. Set sidecar.contextProviders[].token.' };
  }

  try {
    // Build JQL based on filter
    const jqlParts: string[] = ['statusCategory != Done'];
    if (config.filter === 'assigned') jqlParts.push('assignee = currentUser()');
    if (config.project) jqlParts.push(`project = "${config.project}"`);
    const jql = jqlParts.join(' AND ') + ' ORDER BY updated DESC';

    const params = new URLSearchParams({
      jql,
      maxResults: String(config.maxIssues || 5),
      fields: 'summary,status,description,priority,labels,updated,issuetype',
    });

    const url = `${base}/rest/api/3/search?${params}`;
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      return { providerLabel, issues: [], error: `Jira API error: ${res.status} ${res.statusText}` };
    }

    const json = (await res.json()) as { issues?: JiraIssue[] };
    const raw = json.issues ?? [];
    const issues: ContextIssue[] = raw.map((ji) => ({
      id: ji.key,
      title: ji.fields.summary,
      status: ji.fields.status.name,
      body: extractJiraText(ji.fields.description) || undefined,
      labels: ji.fields.labels?.filter(Boolean),
      priority: ji.fields.priority?.name,
      updatedAt: ji.fields.updated ? new Date(ji.fields.updated).toLocaleDateString() : undefined,
    }));

    return { providerLabel, issues };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { providerLabel, issues: [], error: `Jira fetch failed: ${msg}` };
  }
}
