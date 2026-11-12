import { z } from 'zod';
import { markdownTable } from '../format.js';
import { parseFilters } from '../parsers/filters.js';
import { parseExpertTests } from '../parsers/tests.js';
import { parseListingMeta } from '../parsers/tiles.js';
import type { Registration } from './index.js';
import {
  categoryIdInput,
  CoreDataMissingError,
  finish,
  handle,
  pageInput,
  pagingFooter,
  pagingSchema,
  productUrl,
  READ_ONLY,
  siteUrl,
  warningsField,
} from './shared.js';

const TEST_PAGE_SIZE = 30;
const TEST_SORTS = ['rating_date_desc', 'rating_date_asc', 'rating_desc', 'rating_asc'] as const;

const expertTestsOutput = z.object({
  url: z.string(),
  ...pagingSchema,
  tests: z.array(
    z.object({
      product_id: z.string(),
      product_title: z.string(),
      outlet: z.string(),
      quote: z.string().optional(),
      rating_value: z.number().optional(),
      rating_max: z.number().optional(),
      date: z.string().optional(),
      review_url: z.string().optional(),
      category_id: z.string().optional(),
      category_name: z.string().optional(),
      product_url: z.string(),
    }),
  ),
  outlets: z.array(z.object({ name: z.string(), count: z.number().optional() })).optional(),
  ...warningsField,
});

export const registerTestTools: Registration = (server, ctx) => {
  server.registerTool(
    'get_expert_tests',
    {
      title: 'Expert tests',
      description:
        'Browse expert reviews (Tek.no, Lyd & bilde, Tom\'s Guide and others) linked to godpris.no products, 30 per page, newest first by default. Use to find well-reviewed products in a category or from one outlet; page 1 also lists the available outlets and review counts.',
      inputSchema: {
        category_id: categoryIdInput.optional(),
        outlet: z.string().trim().min(1).max(100).optional().describe('Only reviews from this outlet, e.g. "Tek.no" (names are listed in "outlets" on page 1).'),
        brand: z.string().trim().min(1).max(100).optional().describe('Only products of this brand.'),
        sort: z.enum(TEST_SORTS).optional().describe('Sort order (default: newest review first).'),
        page: pageInput,
      },
      outputSchema: expertTestsOutput,
      annotations: READ_ONLY,
    },
    handle(
      'get_expert_tests',
      async (args: {
        category_id?: string | undefined;
        outlet?: string | undefined;
        brand?: string | undefined;
        sort?: (typeof TEST_SORTS)[number] | undefined;
        page: number;
      }) => {
        const userQuery = {
          ...(args.category_id ? { c: args.category_id } : {}),
          ...(args.outlet ? { site: args.outlet } : {}),
          ...(args.brand ? { b: args.brand } : {}),
          ...(args.sort ? { s: args.sort } : {}),
        };
        const url = siteUrl('/tester', userQuery);
        const reqQuery =
          args.page > 1
            ? { ...userQuery, o: (args.page - 1) * TEST_PAGE_SIZE, l: TEST_PAGE_SIZE, fragment: 1 }
            : userQuery;
        const html = await ctx.client.getHtml('/tester', { query: reqQuery });
        const parsed = parseExpertTests(html);
        const meta = parseListingMeta(html);
        const warnings = [...parsed.warnings];
        if (!parsed.tests.length && meta.total) throw new CoreDataMissingError('expert tests');
        if (!parsed.tests.length && meta.total === undefined && args.page === 1) {
          warnings.push('Could not read the result count; the result may be empty or the layout changed');
        }
        const outlets =
          args.page === 1
            ? parseFilters(html)
                .filters.find((f) => f.key === 'site')
                ?.options?.map((o) => ({ name: o.value, ...(o.count !== undefined ? { count: o.count } : {}) }))
            : undefined;
        const has_next = !!meta.next_url;
        const paging = {
          page: args.page,
          has_next,
          ...(meta.total !== undefined ? { total: meta.total } : {}),
          ...(has_next ? { next_page: args.page + 1 } : {}),
        };
        const tests = parsed.tests.map((t) => ({ ...t, product_url: productUrl(t.product_id) }));
        const lines: string[] = [];
        if (tests.length) {
          lines.push(
            '## Expert tests',
            url,
            '',
            markdownTable(
              ['Product ID', 'Product', 'Outlet', 'Rating', 'Date', 'Review'],
              tests.map((t) => [
                t.product_id,
                `[${t.product_title}](${t.product_url})`,
                t.outlet,
                t.rating_value !== undefined ? `${t.rating_value}/${t.rating_max}` : '',
                t.date ?? '',
                t.review_url ? `[read](${t.review_url})` : '',
              ]),
            ),
            '',
            `${pagingFooter(paging).replace(/products/, 'tests')}`,
          );
          if (outlets?.length) {
            lines.push('', `Outlets: ${outlets.map((o) => `${o.name}${o.count !== undefined ? ` (${o.count})` : ''}`).join(', ')}`);
          }
        } else {
          lines.push(`No expert tests match.\n${url}`);
        }
        return finish(lines.join('\n'), expertTestsOutput, { url, ...paging, tests, ...(outlets ? { outlets } : {}) }, warnings);
      },
    ),
  );
};
