import type { RegisteredTool } from '../tools.js';

/**
 * VizSpec defines the structure for inline code visualization specs.
 * Agents can return VizSpec JSON objects that get rendered as charts, tables, etc.
 */
export interface VizSpec {
  type: 'chart' | 'table' | 'timeline' | 'heatmap';
  title?: string;
  data: unknown[];
  labels: string[];
}

/**
 * Render a VizSpec into self-contained HTML/SVG.
 * Returns inline SVG for chart/table types; other types fall back to styled HTML table.
 */
export function renderVizSpec(spec: VizSpec): string {
  switch (spec.type) {
    case 'chart':
      return renderBarChart(spec);
    case 'table':
      return renderTable(spec);
    case 'timeline':
    case 'heatmap':
    default:
      // Fallback: styled HTML table
      return renderTable(spec);
  }
}

function renderBarChart(spec: VizSpec): string {
  const title = spec.title || 'Chart';
  const maxValue = Math.max(...(spec.data as number[]).filter((v) => typeof v === 'number'));
  const chartHeight = 200;
  const barWidth = Math.max(30, 300 / spec.labels.length);
  const padding = 40;
  const svgWidth = spec.labels.length * barWidth + padding * 2;

  const bars = (spec.data as number[])
    .map((value, idx) => {
      const height = (value / maxValue) * chartHeight;
      const x = padding + idx * barWidth + barWidth / 4;
      const y = chartHeight + padding - height;
      const label = spec.labels[idx] || `Item ${idx}`;

      return `
        <rect x="${x}" y="${y}" width="${barWidth / 2}" height="${height}" fill="#3b82f6" />
        <text x="${x + barWidth / 4}" y="${chartHeight + padding + 20}" text-anchor="middle" font-size="12" fill="#666">${label}</text>
        <text x="${x + barWidth / 4}" y="${y - 5}" text-anchor="middle" font-size="11" fill="#333">${value}</text>
      `;
    })
    .join('\n');

  return `
    <svg width="${svgWidth}" height="${chartHeight + padding * 2 + 40}" xmlns="http://www.w3.org/2000/svg" style="border: 1px solid #e5e7eb; border-radius: 6px; background: white;">
      <text x="${svgWidth / 2}" y="25" text-anchor="middle" font-size="16" font-weight="bold" fill="#1f2937">${title}</text>
      ${bars}
      <line x1="${padding}" y1="${chartHeight + padding}" x2="${svgWidth - padding}" y2="${chartHeight + padding}" stroke="#d1d5db" stroke-width="1" />
    </svg>
  `;
}

function renderTable(spec: VizSpec): string {
  const title = spec.title || 'Data';
  const rows = (spec.data as Record<string, unknown>[]) || [];

  const headerHtml = spec.labels
    .map(
      (label) =>
        `<th style="padding: 8px; text-align: left; border-bottom: 2px solid #d1d5db; font-weight: 600;">${escapeHtml(label)}</th>`,
    )
    .join('');

  const bodyHtml = rows
    .map((row) => {
      const cells = spec.labels
        .map((label) => {
          const value = row[label] ?? '';
          return `<td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(String(value))}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 12px 0; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; background: white;">
      <div style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-weight: 600; font-size: 14px; color: #1f2937;">${escapeHtml(title)}</div>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f9fafb;">${headerHtml}</tr>
        </thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>
  `;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Tool definition for render_viz.
 * Agents call this to embed rendered charts/tables in their responses.
 */
export const vizSpecTools: RegisteredTool[] = [
  {
    definition: {
      name: 'render_viz',
      description:
        'Render a visualization spec (chart, table, timeline, heatmap) inline in the chat. ' +
        'Use when the agent has data to present visually. Pass a VizSpec JSON object with type (chart/table/timeline/heatmap), ' +
        'data array, and labels array. Example: `render_viz({ type: "chart", data: [10, 20, 15], labels: ["Q1", "Q2", "Q3"] })`. ' +
        'NOT for text responses — only when structured visualization makes data clearer.',
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['chart', 'table', 'timeline', 'heatmap'],
            description: 'Type of visualization',
          },
          title: {
            type: 'string',
            description: 'Optional title for the visualization',
          },
          data: {
            type: 'array',
            description: 'Array of data points or objects. For charts: array of numbers. For tables: array of objects.',
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels for each dimension (e.g., bar names for chart, column headers for table)',
          },
        },
        required: ['type', 'data', 'labels'],
      },
    },
    executor: async (input: unknown) => {
      const spec = input as VizSpec;
      return renderVizSpec(spec);
    },
    requiresApproval: false,
  },
];
