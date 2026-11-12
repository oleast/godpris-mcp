import { describe, expect, it } from 'vitest';
import { parseGiftRecipients } from '../../src/parsers/gifts.js';
import { parseStoreList, parseStorePage } from '../../src/parsers/stores.js';
import { fixture } from './helpers.js';

describe('parseStoreList', () => {
  it('parses the shop directory page', () => {
    const r = parseStoreList(fixture('butikk.html'));
    expect(r.warnings).toEqual([]);
    expect(r.stores).toHaveLength(30);
    expect(r.stores[0]).toEqual({ id: '569', name: '112ink & Eko-print', url: 'https://godpris.no/butikk/569' });
    expect(r.stores[1]).toMatchObject({ id: '482', name: '123Friluft' });
    expect(r.has_next).toBe(true);
  });
});

describe('parseStorePage', () => {
  it('parses contact info and popular products', () => {
    const p = parseStorePage(fixture('butikk25.html'));
    expect(p.warnings).toEqual([]);
    expect(p).toMatchObject({
      name: 'Joker',
      website: 'https://joker.no',
      org_number: '977263646',
      contact: {
        email: 'nettbutikk@joker.no',
        phone: '(+47) 24 11 33 30',
        website: 'https://joker.no/om-joker/kundeservice',
      },
    });
    expect(p.popular_products).toHaveLength(18);
    expect(p.popular_products[0]).toMatchObject({ id: '47', brand: 'TINE', price: 61 });
  });
});

describe('parseGiftRecipients', () => {
  it('reads recipient buttons and the current count', () => {
    const r = parseGiftRecipients(fixture('gavetips1.html'));
    expect(r.current_count).toBe(450);
    expect(r.recipients).toHaveLength(8);
    expect(r.recipients.find((x) => x.tag_id === '1')).toEqual({ tag_id: '1', label: 'Til henne', count: 170 });
    expect(r.recipients[0]).toEqual({ label: 'Til alle', count: 450 });
  });
});
