import { z } from 'zod';
import { contextOf, handler, scopeOf } from '../../lib/http.js';
import * as purchaseService from './purchase.service.js';
import * as itcService from './itc.service.js';
import {
  cancelPurchaseSchema,
  claimItcSchema,
  createPurchaseSchema,
  gstSummaryQuerySchema,
  listPurchasesQuerySchema,
  previewPurchaseSchema,
} from './purchase.schemas.js';

export const preview = handler(async (req, res) => {
  const input = previewPurchaseSchema.parse(req.body);
  res.json(await purchaseService.previewPurchase(scopeOf(req).businessId, input));
});

export const create = handler(async (req, res) => {
  const input = createPurchaseSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.status(201).json(await purchaseService.createPurchase(businessId, userId, input, contextOf(req)));
});

export const list = handler(async (req, res) => {
  const filter = listPurchasesQuerySchema.parse(req.query);
  res.json(await purchaseService.listPurchases(scopeOf(req).businessId, filter));
});

export const getOne = handler(async (req, res) => {
  res.json({
    purchase: await purchaseService.getPurchase(scopeOf(req).businessId, req.params.purchaseId!),
  });
});

export const cancel = handler(async (req, res) => {
  const { reason } = cancelPurchaseSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json(
    await purchaseService.cancelPurchase(businessId, userId, req.params.purchaseId!, reason, contextOf(req)),
  );
});

export const productHistory = handler(async (req, res) => {
  const limit = z.coerce.number().int().positive().max(100).optional().parse(req.query.limit) ?? 20;
  res.json(
    await purchaseService.getProductPurchaseHistory(
      scopeOf(req).businessId,
      req.params.productId!,
      limit,
    ),
  );
});

// ---------------------------------------------------------------------------
// Input tax credit
// ---------------------------------------------------------------------------

export const claimItc = handler(async (req, res) => {
  const input = claimItcSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json(await itcService.claimInputCredit(businessId, userId, input, contextOf(req)));
});

export const unclaimItc = handler(async (req, res) => {
  const { businessId, userId } = scopeOf(req);
  res.json(
    await itcService.unclaimInputCredit(businessId, userId, req.params.purchaseId!, contextOf(req)),
  );
});

export const pendingItc = handler(async (req, res) => {
  const beforeDate = z.coerce.date().optional().parse(req.query.beforeDate);
  res.json(await itcService.getPendingItc(scopeOf(req).businessId, beforeDate));
});

/// Output tax vs input credit, with the set-off applied. The "what do I owe
/// the government this month" report.
export const gstSummary = handler(async (req, res) => {
  const query = gstSummaryQuerySchema.parse(req.query);
  res.json(await itcService.getGstSummary(scopeOf(req).businessId, query));
});
