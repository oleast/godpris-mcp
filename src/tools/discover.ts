import { z } from 'zod';
import { formatKr, markdownTable } from '../format.js';
import { parseFilters } from '../parsers/filters.js';
import { parseGiftRecipients } from '../parsers/gifts.js';
import { parseListingMeta, parseProductTiles } from '../parsers/tiles.js';
import type { Registration, ToolContext } from './index.js';
import {
  buildListingQuery,
  categoryIdInput,
  compactRowSchema,
  CoreDataMissingError,
  finish,
  handle,
  listingTable,
  pageInput,
  pagingFooter,
  pagingSchema,
  priceMaxInput,
  priceMinInput,
  READ_ONLY,
  recordLowInput,
  siteUrl,
  toCompactRow,
  warningsField,
  type CompactRow,
} from './shared.js';

const DEALS_PAGE_SIZE = 48;
const GIFTS_PAGE_SIZE = 100;
const DEAL_SORTS = ['relevance', 'popularity', 'offer_created_desc', 'discount_desc', 'price_asc', 'price_desc'] as const;
const CAMPAIGNS = ['black-friday', 'singles-day', 'romjulssalg', 'januarsalg'] as const;
const RECIPIENT_TAGS = { her: '1', him: '4', father: '6', mother: '7', brother: '8', sister: '9', child: '42' } as const;
const TRENDING_KINDS = ['todays_deals', 'most_watched'] as const;

const dealRowSchema = compactRowSchema.extend({ shop: z.string().optional() });

const dealsOutput = z.object({
  url: z.string(),
  ...pagingSchema,
  items: z.array(dealRowSchema),
  ...warningsField,
});

const giftsOutput = z.object({
  recipient: z.string().optional(),
  url: z.string(),
  ...pagingSchema,
  items: z.array(compactRowSchema),
  ...warningsField,
});

const trendingOutput = z.object({
  kind: z.string(),
  source: z.string(),
  items: z.array(compactRowSchema),
  ...warningsField,
});

/** Request query for a load-more listing: first page plain, later pages via the fragment endpoint. */
function pagedQuery<Q extends Record<string, unknown>>(userQuery: Q, page: number, size: number) {
  return page > 1 ? { ...userQuery, o: (page - 1) * size, l: size, fragment: 1 } : userQuery;
}

/** The deals filter takes a shop id; names are looked up among the shops that have offers now. */
async function findShopId(ctx: ToolContext, shop: string): Promise<string | undefined> {
  if (/^\d+$/.test(shop)) return shop;
  const filters = parseFilters(await ctx.client.getHtml('/tilbud')).filters;
  const options = filters.find((f) => f.key === 'shop')?.options ?? [];
  return options.find((o) => o.label.toLowerCase() === shop.toLowerCase())?.value;
}

export const registerDiscoverTools: Registration = (server, ctx) => {
  server.registerTool(
    'get_deals',
    {
      title: 'Get deals',
      description:
        'Current discounted offers across godpris.no (about 185 000), 48 per page, optionally for a sales campaign. Use to find the best deals by discount, price, shop or record-low status; category_id only accepts top-level categories.',
      inputSchema: {
        campaign: z.enum(CAMPAIGNS).optional().describe('Sales campaign page instead of all deals.'),
        category_id: categoryIdInput.optional(),
        shop: z.string().trim().min(1).max(100).optional().describe('Only offers from this shop, by name (e.g. "Elkjøp") or store id. Shops without current offers return no deals.'),
        discount_min: z.coerce.number().int().min(0).max(100).optional().describe('Minimum discount in percent.'),
        price_min: priceMinInput,
        price_max: priceMaxInput,
        record_low_only: recordLowInput,
        sort: z.enum(DEAL_SORTS).optional().describe('Sort order (default relevance, i.e. "Aktuelt"; offer_created_desc = newest offers).'),
        page: pageInput,
      },
      outputSchema: dealsOutput,
      annotations: READ_ONLY,
    },
    handle(
      'get_deals',
      async (args: {
        campaign?: (typeof CAMPAIGNS)[number] | undefined;
        category_id?: string | undefined;
        shop?: string | undefined;
        discount_min?: number | undefined;
        price_min?: number | undefined;
        price_max?: number | undefined;
        record_low_only?: boolean | undefined;
        sort?: (typeof DEAL_SORTS)[number] | undefined;
        page: number;
      }) => {
        const warnings: string[] = [];
        const shopId = args.shop ? await findShopId(ctx, args.shop) : undefined;
        if (args.shop && !shopId) {
          const url = siteUrl('/tilbud');
          const paging = { page: args.page, has_next: false, total: 0 };
          return finish(`No current offers from shop "${args.shop}".\n${url}`, dealsOutput, { url, ...paging, items: [] }, warnings);
        }
        const userQuery = {
          ...buildListingQuery({ ...args, page: undefined }, warnings),
          ...(args.category_id ? { c: args.category_id } : {}),
          ...(shopId ? { shop: shopId } : {}),
        };
        const path = args.campaign ? `/tilbud/${args.campaign}` : '/tilbud';
        const url = siteUrl(path, userQuery);
        const html = await ctx.client.getHtml(path, { query: pagedQuery(userQuery, args.page, DEALS_PAGE_SIZE) });
        const tiles = parseProductTiles(html);
        const meta = parseListingMeta(html);
        warnings.push(...tiles.warnings);

        const items = tiles.items.map((t) => ({ ...toCompactRow(t), ...(t.offer_shop ? { shop: t.offer_shop } : {}) }));
        if (!items.length && meta.total && meta.total > 0) throw new CoreDataMissingError('deal rows');
        if (!items.length && meta.total === undefined && args.page === 1) {
          warnings.push('Could not read the result count; the result may be empty or the layout changed');
        }
        const has_next = !!meta.next_url;
        const paging = {
          page: args.page,
          has_next,
          ...(meta.total !== undefined ? { total: meta.total } : {}),
          ...(has_next ? { next_page: args.page + 1 } : {}),
        };
        const text = items.length
          ? [
              `## Deals${args.campaign ? ` (${args.campaign})` : ''}`,
              url,
              '',
              markdownTable(
                ['ID', 'Product', 'Shop', 'Price', 'Discount', 'Record low'],
                items.map((r) => [
                  r.id,
                  `[${[r.brand, r.title].filter(Boolean).join(' ')}](${r.url})`,
                  r.shop ?? '',
                  r.price !== undefined ? formatKr(r.price) : '',
                  r.discount_pct !== undefined ? `${r.discount_pct} %` : '',
                  r.record_low ? 'yes' : '',
                ]),
              ),
              '',
              pagingFooter(paging).replace(/products/, 'deals'),
            ].join('\n')
          : `No deals match.\n${url}`;
        return finish(text, dealsOutput, { url, ...paging, items }, warnings);
      },
    ),
  );

  server.registerTool(
    'get_gift_ideas',
    {
      title: 'Gift ideas',
      description:
        'Gift ideas from the godpris.no gift guide (about 450), 100 per page, optionally for one recipient. Use when the user wants present suggestions; without a recipient it lists ideas for everyone.',
      inputSchema: {
        recipient: z.enum(['her', 'him', 'father', 'mother', 'brother', 'sister', 'child']).optional().describe('Recipient group (default: all).'),
        page: pageInput,
      },
      outputSchema: giftsOutput,
      annotations: READ_ONLY,
    },
    handle(
      'get_gift_ideas',
      async (args: { recipient?: keyof typeof RECIPIENT_TAGS | undefined; page: number }) => {
        const userQuery = args.recipient ? { tag_id: RECIPIENT_TAGS[args.recipient] } : {};
        const url = siteUrl('/gavetips/1', userQuery);
        const html = await ctx.client.getHtml('/gavetips/1', { query: pagedQuery(userQuery, args.page, GIFTS_PAGE_SIZE) });
        const tiles = parseProductTiles(html);
        const meta = parseListingMeta(html);
        const warnings = [...tiles.warnings];
        const total = args.page === 1 ? parseGiftRecipients(html).current_count : undefined;
        const items: CompactRow[] = tiles.items.map(toCompactRow);
        if (!items.length && args.page === 1) warnings.push('No gift ideas found; the result may be empty or the layout changed');
        const has_next = !!meta.next_url;
        const paging = {
          page: args.page,
          has_next,
          ...(total !== undefined ? { total } : {}),
          ...(has_next ? { next_page: args.page + 1 } : {}),
        };
        const text = items.length
          ? [
              `## Gift ideas${args.recipient ? ` for ${args.recipient}` : ''}`,
              url,
              '',
              listingTable(items),
              '',
              pagingFooter(paging).replace(/products/, 'ideas'),
            ].join('\n')
          : `No gift ideas found.\n${url}`;
        return finish(
          text,
          giftsOutput,
          { ...(args.recipient ? { recipient: args.recipient } : {}), url, ...paging, items },
          warnings,
        );
      },
    ),
  );

  server.registerTool(
    'get_trending',
    {
      title: 'Trending products',
      description:
        'Front-page carousels: today\'s deals or the most-watched products. Use for a quick "what is hot now" overview; when category_id is given, that category\'s carousel is returned regardless of kind.',
      inputSchema: {
        kind: z.enum(TRENDING_KINDS).default('todays_deals').describe('Which front-page carousel (ignored when category_id is given).'),
        category_id: categoryIdInput.optional(),
      },
      outputSchema: trendingOutput,
      annotations: READ_ONLY,
    },
    handle(
      'get_trending',
      async (args: { kind: (typeof TRENDING_KINDS)[number]; category_id?: string | undefined }) => {
        const source = args.category_id
          ? `/api/carousel/category/${args.category_id}`
          : args.kind === 'most_watched'
            ? '/api/carousel/frontpage/most-watched'
            : '/api/carousel/frontpage/offers';
        const tiles = parseProductTiles(await ctx.client.getHtml(source, { notFoundOn500: true }));
        const items: CompactRow[] = tiles.items.map(toCompactRow);
        const kind = args.category_id ? 'category' : args.kind;
        const title = args.category_id
          ? `Popular in category ${args.category_id}`
          : args.kind === 'most_watched'
            ? 'Most watched'
            : "Today's deals";
        const text = items.length ? [`## ${title}`, '', listingTable(items)].join('\n') : `Nothing trending found for ${title}.`;
        return finish(text, trendingOutput, { kind, source, items }, tiles.warnings);
      },
    ),
  );
};
