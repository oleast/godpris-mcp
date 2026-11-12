import { z } from 'zod';
import { markdownTable } from '../format.js';
import { parseStoreList, parseStorePage } from '../parsers/stores.js';
import type { Registration } from './index.js';
import {
  compactRowSchema,
  CoreDataMissingError,
  finish,
  handle,
  listingTable,
  pageInput,
  pagingFooter,
  pagingSchema,
  READ_ONLY,
  siteUrl,
  toCompactRow,
  warningsField,
} from './shared.js';

const storeIdInput = z.coerce
  .string()
  .regex(/^\d{1,9}$/)
  .describe('godpris.no store id, e.g. "25" (from list_stores or the shop ids in get_product).');

const listStoresOutput = z.object({
  ...pagingSchema,
  stores: z.array(z.object({ id: z.string(), name: z.string(), url: z.string() })),
  ...warningsField,
});

const getStoreOutput = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  website: z.string().optional(),
  org_number: z.string().optional(),
  contact: z.object({
    email: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
  }),
  popular_products: z.array(compactRowSchema),
  ...warningsField,
});

export const registerStoreTools: Registration = (server, ctx) => {
  server.registerTool(
    'list_stores',
    {
      title: 'List stores',
      description:
        'Directory of the roughly 900 shops known to godpris.no, 30 per page in alphabetical order. Use to find a store id, then call get_store for contact details.',
      inputSchema: { page: pageInput },
      outputSchema: listStoresOutput,
      annotations: READ_ONLY,
    },
    handle('list_stores', async ({ page }: { page: number }) => {
      const parsed = parseStoreList(await ctx.client.getHtml('/butikk', { query: page > 1 ? { page } : {} }));
      if (!parsed.stores.length) {
        if (page > 1) return finish(`No stores on page ${page}.`, listStoresOutput, { page, has_next: false, stores: [] });
        throw new CoreDataMissingError('stores');
      }
      const paging = { page, has_next: parsed.has_next, ...(parsed.has_next ? { next_page: page + 1 } : {}) };
      const text = [
        '## Stores',
        '',
        markdownTable(
          ['ID', 'Store'],
          parsed.stores.map((s) => [s.id, `[${s.name}](${s.url})`]),
        ),
        '',
        pagingFooter(paging),
      ].join('\n');
      return finish(text, listStoresOutput, { ...paging, stores: parsed.stores }, parsed.warnings);
    }),
  );

  server.registerTool(
    'get_store',
    {
      title: 'Get store',
      description:
        'Contact details (email, phone, website, org number) and popular products for one shop. Use after list_stores or when a product offer names a shop and the user wants to reach it.',
      inputSchema: { store_id: storeIdInput },
      outputSchema: getStoreOutput,
      annotations: READ_ONLY,
    },
    handle(
      'get_store',
      async ({ store_id }: { store_id: string }) => {
        const p = parseStorePage(await ctx.client.getHtml(`/butikk/${store_id}`, { notFoundOn500: true }));
        if (!p.name) throw new CoreDataMissingError('store name');
        const url = siteUrl(`/butikk/${store_id}`);
        const popular = p.popular_products.map(toCompactRow);
        const lines = [`## ${p.name}`, url, ''];
        if (p.website) lines.push(`- Website: ${p.website}`);
        if (p.org_number) lines.push(`- Org number: ${p.org_number}`);
        if (p.contact.email) lines.push(`- Email: ${p.contact.email}`);
        if (p.contact.phone) lines.push(`- Phone: ${p.contact.phone}`);
        if (p.contact.website) lines.push(`- Customer service: ${p.contact.website}`);
        if (popular.length) lines.push('', `### Popular products at ${p.name}`, '', listingTable(popular));
        return finish(
          lines.join('\n'),
          getStoreOutput,
          {
            id: store_id,
            name: p.name,
            url,
            ...(p.website ? { website: p.website } : {}),
            ...(p.org_number ? { org_number: p.org_number } : {}),
            contact: p.contact,
            popular_products: popular,
          },
          p.warnings,
        );
      },
      ({ store_id }) => `Store ${store_id} not found on godpris.no`,
    ),
  );
};
