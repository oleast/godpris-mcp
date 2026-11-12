import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import { markdownTable, formatKr } from '../format.js';
import { parseComparePage, type ComparePage } from '../parsers/compare.js';
import type { Registration } from './index.js';
import { CoreDataMissingError, finish, handle, productIdInput, productUrl, READ_ONLY, siteUrl, warningsField } from './shared.js';

const compareOutput = z.object({
  url: z.string(),
  products: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      brand: z.string().optional(),
      price: z.number().optional(),
      url: z.string(),
    }),
  ),
  rows: z.array(
    z.object({
      group: z.string().optional(),
      name: z.string(),
      values: z.array(z.string()),
    }),
  ),
  total_rows: z.number(),
  differences_only: z.boolean(),
  ...warningsField,
});

/** Fetch and parse the /sammenlign page for the given ids. */
export async function fetchCompare(http: HttpClient, ids: string[]): Promise<ComparePage> {
  return parseComparePage(await http.getHtml('/sammenlign', { query: { ids: ids.join(',') } }));
}

export const registerCompareTools: Registration = (server, ctx) => {
  server.registerTool(
    'compare_products',
    {
      title: 'Compare products',
      description:
        'Side-by-side specification comparison of 2-6 products on godpris.no. Use after search or browse to pick between candidates; by default only specs that differ are shown, and "values" align with "products" (empty means unknown).',
      inputSchema: {
        product_ids: z.array(productIdInput).min(2).max(6).describe('2 to 6 product ids to compare.'),
        differences_only: z.boolean().default(true).describe('Drop spec rows where all products have the same value (default true).'),
      },
      outputSchema: compareOutput,
      annotations: READ_ONLY,
    },
    handle(
      'compare_products',
      async ({ product_ids, differences_only }: { product_ids: string[]; differences_only: boolean }) => {
        const ids = [...new Set(product_ids)];
        const url = siteUrl('/sammenlign', { ids: ids.join(',') });
        const page = await fetchCompare(ctx.client, ids);
        if (!page.products.length) throw new CoreDataMissingError('products to compare');
        const warnings = [...page.warnings];
        if (page.products.length < ids.length) {
          const found = new Set(page.products.map((p) => p.id));
          warnings.push(`Not found on the compare page: ${ids.filter((i) => !found.has(i)).join(', ')}`);
        }
        const aligned = page.rows.filter((r) => r.values.length === page.products.length);
        if (aligned.length < page.rows.length) warnings.push('Some spec rows did not match the product columns and were skipped');
        const rows = differences_only ? aligned.filter((r) => new Set(r.values).size > 1) : aligned;

        const names = page.products.map((p) => [p.brand, p.title].filter(Boolean).join(' '));
        const table = markdownTable(
          ['Group', 'Specification', ...page.products.map((p, i) => `[${names[i]}](${p.url})`)],
          [
            ['', 'Price', ...page.products.map((p) => (p.price !== undefined ? formatKr(p.price) : ''))],
            ...rows.map((r) => [r.group ?? '', r.name, ...r.values.map((v) => v || '–')]),
          ],
        );
        const text = [
          `## Comparison of ${page.products.length} products${differences_only ? ' (differences only)' : ''}`,
          url,
          '',
          table,
          '',
          `${rows.length} of ${aligned.length} spec rows shown. Use get_product with an id for offers and full specs.`,
        ].join('\n');
        return finish(
          text,
          compareOutput,
          {
            url,
            products: page.products.map((p) => ({ ...p, url: productUrl(p.id) })),
            rows,
            total_rows: aligned.length,
            differences_only,
          },
          warnings,
        );
      },
    ),
  );
};
