import { describe, it, expect } from 'vitest';
import { renderVizSpec, type VizSpec } from './vizSpec.js';

describe('renderVizSpec', () => {
  describe('chart type', () => {
    it('renders an SVG bar chart for type=chart', () => {
      const spec: VizSpec = {
        type: 'chart',
        title: 'My Chart',
        data: [10, 20, 30],
        labels: ['A', 'B', 'C'],
      };
      const html = renderVizSpec(spec);
      expect(html).toContain('<svg');
      expect(html).toContain('My Chart');
      expect(html).toContain('<rect');
    });

    it('uses default title when none provided', () => {
      const spec: VizSpec = { type: 'chart', data: [5, 10], labels: ['X', 'Y'] };
      const html = renderVizSpec(spec);
      expect(html).toContain('Chart');
    });

    it('renders one rect per data point', () => {
      const spec: VizSpec = { type: 'chart', data: [1, 2, 3, 4], labels: ['a', 'b', 'c', 'd'] };
      const html = renderVizSpec(spec);
      const rectCount = (html.match(/<rect /g) || []).length;
      expect(rectCount).toBe(4);
    });

    it('includes label text in the chart', () => {
      const spec: VizSpec = { type: 'chart', data: [42], labels: ['Revenue'] };
      const html = renderVizSpec(spec);
      expect(html).toContain('Revenue');
      expect(html).toContain('42');
    });

    it('uses "Item N" for missing labels', () => {
      const spec: VizSpec = { type: 'chart', data: [10, 20], labels: ['Only'] };
      const html = renderVizSpec(spec);
      expect(html).toContain('Item 1');
    });
  });

  describe('table type', () => {
    it('renders a table for type=table', () => {
      const spec: VizSpec = {
        type: 'table',
        title: 'Users',
        data: [
          { name: 'Alice', age: 30 },
          { name: 'Bob', age: 25 },
        ],
        labels: ['name', 'age'],
      };
      const html = renderVizSpec(spec);
      expect(html).toContain('<table');
      expect(html).toContain('Users');
      expect(html).toContain('Alice');
      expect(html).toContain('Bob');
      expect(html).toContain('30');
    });

    it('renders column headers from labels', () => {
      const spec: VizSpec = {
        type: 'table',
        data: [{ x: 1, y: 2 }],
        labels: ['x', 'y'],
      };
      const html = renderVizSpec(spec);
      expect(html).toContain('<th');
      expect(html).toContain('>x<');
      expect(html).toContain('>y<');
    });

    it('uses default title when none provided', () => {
      const spec: VizSpec = { type: 'table', data: [], labels: ['col'] };
      const html = renderVizSpec(spec);
      expect(html).toContain('Data');
    });

    it('escapes HTML in cell values', () => {
      const spec: VizSpec = {
        type: 'table',
        data: [{ val: '<script>alert("xss")</script>' }],
        labels: ['val'],
      };
      const html = renderVizSpec(spec);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes special chars in table headers', () => {
      const spec: VizSpec = {
        type: 'table',
        data: [],
        labels: ['Price & Tax'],
      };
      const html = renderVizSpec(spec);
      expect(html).toContain('Price &amp; Tax');
    });

    it('shows empty cell for missing row field', () => {
      const spec: VizSpec = {
        type: 'table',
        data: [{ a: 'hello' }] as Record<string, unknown>[],
        labels: ['a', 'b'],
      };
      const html = renderVizSpec(spec);
      expect(html).toContain('hello');
    });
  });

  describe('timeline and heatmap (fallback to table)', () => {
    it('renders a table for type=timeline', () => {
      const spec: VizSpec = {
        type: 'timeline',
        title: 'Events',
        data: [{ event: 'Start', date: '2025-01' }],
        labels: ['event', 'date'],
      };
      const html = renderVizSpec(spec);
      expect(html).toContain('<table');
      expect(html).toContain('Events');
      expect(html).toContain('Start');
    });

    it('renders a table for type=heatmap', () => {
      const spec: VizSpec = {
        type: 'heatmap',
        data: [{ cell: 'hot' }],
        labels: ['cell'],
      };
      const html = renderVizSpec(spec);
      expect(html).toContain('<table');
      expect(html).toContain('hot');
    });
  });
});
