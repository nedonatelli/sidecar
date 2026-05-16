import type { ContextProviderConfig, ContextProviderResult, ContextIssue } from '../types.js';

const LINEAR_API = 'https://api.linear.app/graphql';

interface LinearIssue {
  identifier: string;
  title: string;
  state: { name: string };
  description: string | null;
  url: string;
  priority: number;
  updatedAt: string;
  labels: { nodes: Array<{ name: string }> };
}

const PRIORITY_LABEL: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

function buildQuery(filter: string, maxIssues: number): string {
  const filterClause =
    filter === 'assigned'
      ? 'filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "cancelled"] } } }'
      : filter === 'recent'
        ? 'filter: { state: { type: { nin: ["completed", "cancelled"] } } } orderBy: updatedAt'
        : 'filter: { state: { type: { nin: ["completed", "cancelled"] } } }';

  return `{
    issues(${filterClause} first: ${maxIssues}) {
      nodes {
        identifier title url description updatedAt priority
        state { name }
        labels { nodes { name } }
      }
    }
  }`;
}

export async function fetchLinearIssues(
  config: ContextProviderConfig,
  fetchFn: typeof fetch = fetch,
): Promise<ContextProviderResult> {
  const providerLabel = 'Linear';

  if (!config.token) {
    return { providerLabel, issues: [], error: 'No API key configured. Set sidecar.contextProviders[].token.' };
  }

  try {
    const res = await fetchFn(LINEAR_API, {
      method: 'POST',
      headers: {
        Authorization: config.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: buildQuery(config.filter, config.maxIssues || 5) }),
    });

    if (!res.ok) {
      return { providerLabel, issues: [], error: `Linear API error: ${res.status} ${res.statusText}` };
    }

    const json = (await res.json()) as { data?: { issues?: { nodes: LinearIssue[] } }; errors?: unknown[] };
    if (json.errors?.length) {
      return { providerLabel, issues: [], error: `Linear GraphQL error: ${JSON.stringify(json.errors[0])}` };
    }

    const raw = json.data?.issues?.nodes ?? [];
    const issues: ContextIssue[] = raw.map((li) => ({
      id: li.identifier,
      title: li.title,
      status: li.state.name,
      body: li.description ? li.description.slice(0, 400) + (li.description.length > 400 ? '…' : '') : undefined,
      url: li.url,
      labels: li.labels.nodes.map((l) => l.name),
      priority: PRIORITY_LABEL[li.priority] ?? String(li.priority),
      updatedAt: li.updatedAt ? new Date(li.updatedAt).toLocaleDateString() : undefined,
    }));

    return { providerLabel, issues };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { providerLabel, issues: [], error: `Linear fetch failed: ${msg}` };
  }
}
