import * as cheerio from 'cheerio';
import { clean, parseCount } from './util.js';

export interface GiftRecipient {
  /** `tag_id` query value; absent for the "all" button. */
  tag_id?: string;
  label: string;
  count?: number;
}

export interface GiftRecipientsResult {
  recipients: GiftRecipient[];
  /** Number of gift ideas for the currently selected recipient. */
  current_count?: number;
}

/** Parse the recipient buttons ("Til alle (450)", "Til barn (92)", ...) of /gavetips/1. */
export function parseGiftRecipients(html: string): GiftRecipientsResult {
  const $ = cheerio.load(html);
  const recipients: GiftRecipient[] = [];
  let current_count: number | undefined;
  $('a[href*="/gavetips/"][data-swap-link]').each((_, el) => {
    const a = $(el);
    const count = parseCount(a.find('.text-xs').first().text());
    const label = clean(a.clone().find('.text-xs').remove().end().text());
    const tag = /[?&]tag_id=(\d+)/.exec(a.attr('href') ?? '')?.[1];
    recipients.push({ ...(tag ? { tag_id: tag } : {}), label, ...(count !== undefined ? { count } : {}) });
    if (a.attr('aria-current') === 'page') current_count = count;
  });
  return { recipients, ...(current_count !== undefined ? { current_count } : {}) };
}
