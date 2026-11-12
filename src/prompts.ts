import { z } from 'zod';
import type { Registration } from './tools/index.js';

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

const registerDealHunt: Registration = (server) => {
  server.registerPrompt(
    'deal-hunt',
    {
      title: 'Deal hunt',
      description: 'Find genuinely good current deals on godpris.no, optionally for a product type and under a price.',
      argsSchema: {
        what: z.string().optional().describe('What to hunt for, e.g. "robot vacuum"; empty for the best deals overall.'),
        max_price: z.string().optional().describe('Maximum price in NOK, e.g. "5000".'),
      },
    },
    ({ what, max_price }) =>
      userMessage(
        [
          `Find genuinely good deals on godpris.no${what ? ` for: ${what}` : ''}${max_price ? `, at most ${max_price} NOK` : ''}.`,
          '',
          'Steps:',
          what
            ? '1. Call find_category (or search_products) to resolve the product type to a category id.'
            : '1. Skip category resolution and look at the site-wide deals.',
          `2. Call hunt_deals${what ? ' with category_ids=[that category id]' : ''} to scan discounted offers and verify the top ones against price history${max_price ? `; pass max_price=${max_price}` : ''}. Use get_deals directly if you only need a plain listing, or browse_category to look at a specific category.`,
          '3. For the most promising items call get_price_history and discard deals where the "before" price looks inflated (today is not near the 90-day or all-time low).',
          '4. Present a short ranked list: product, price, shop, discount, and why it is a real deal. Offer watchlist_add for items the user wants to track.',
        ].join('\n'),
      ),
  );
};

const registerShouldIBuy: Registration = (server) => {
  server.registerPrompt(
    'should-i-buy',
    {
      title: 'Should I buy now?',
      description: 'Judge whether now is a good time to buy a specific product, using price history and current offers.',
      argsSchema: {
        product: z.string().describe('Product name or godpris.no product id.'),
      },
    },
    ({ product }) =>
      userMessage(
        [
          `Should I buy "${product}" now, or wait? Use godpris.no.`,
          '',
          'Steps:',
          '1. If the input is not a numeric product id, call search_products to find the product id (ask me if several products match).',
          '2. Call evaluate_purchase with the product id for the combined price, history and verdict.',
          '3. If you need more detail, call get_product for every shop offer and get_price_history for the full series (range "all").',
          '4. Answer: buy now / OK / wait, with today\'s cheapest in-stock price and shop, how it compares with the 90-day and all-time low, and the site\'s own zone. If the answer is wait, offer watchlist_add with a target price.',
        ].join('\n'),
      ),
  );
};

const registerFindByRequirements: Registration = (server) => {
  server.registerPrompt(
    'find-by-requirements',
    {
      title: 'Find by requirements',
      description: 'Find products of a type that meet concrete specs, then compare the best options.',
      argsSchema: {
        product_type: z.string().describe('Product type, e.g. "washing machine".'),
        requirements: z.string().describe('Requirements in plain language, e.g. "at least 9 kg, energy class A, under 8000 kr".'),
      },
    },
    ({ product_type, requirements }) =>
      userMessage(
        [
          `Find the best ${product_type} on godpris.no that meets these requirements: ${requirements}`,
          '',
          'Steps:',
          '1. Call find_category to get the category id for the product type.',
          '2. Call get_category_filters to see the real filter labels and ranges, and translate each requirement into {label, min?, max?, values?}.',
          '3. Call find_products_by_requirements with query, category_id and those requirements. If some come back unmatched, retry using the available filter labels, or use browse_category with explicit filter keys.',
          '4. Call compare_products with product_ids set to the ids of the top candidates (or get_product for one) and check get_price_history or evaluate_purchase for the finalist.',
          '5. Recommend one or two products with price, key specs and any requirement that could not be verified. Offer watchlist_add for the pick.',
        ].join('\n'),
      ),
  );
};

/** MCP prompts. Arguments are strings, as the protocol requires. */
export const promptRegistrations: Registration[] = [registerDealHunt, registerShouldIBuy, registerFindByRequirements];
