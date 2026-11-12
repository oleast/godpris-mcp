import type { Registration } from '../index.js';
import { registerCompareBestOptions } from './best-options.js';
import { registerEvaluatePurchase } from './evaluate.js';
import { registerFindByRequirements } from './requirements.js';
import { registerHuntDeals } from './hunt.js';
import { registerScanCategory } from './scan.js';

export const registerCompositeTools: Registration = (server, ctx) => {
  registerEvaluatePurchase(server, ctx);
  registerFindByRequirements(server, ctx);
  registerHuntDeals(server, ctx);
  registerScanCategory(server, ctx);
  registerCompareBestOptions(server, ctx);
};
