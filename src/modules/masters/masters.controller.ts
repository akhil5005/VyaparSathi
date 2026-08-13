import { z } from 'zod';
import { contextOf, handler, scopeOf } from '../../lib/http.js';
import * as unitService from './unit.service.js';
import * as hsnService from './hsn.service.js';
import * as partyService from './party.service.js';
import * as productService from './product.service.js';
import {
  addHsnRateSchema,
  adjustStockSchema,
  createHsnSchema,
  createPartySchema,
  createProductSchema,
  createUnitSchema,
  listPartiesQuerySchema,
  listProductsQuerySchema,
  openingStockSchema,
  setPartyRateSchema,
  setProductUnitSchema,
  updateHsnSchema,
  updatePartySchema,
  updateProductSchema,
  updateUnitSchema,
} from './masters.schemas.js';

const dateRangeQuery = z.object({
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
});

const boolQuery = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true')
  .optional();

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const listUnits = handler(async (req, res) => {
  const includeInactive = boolQuery.parse(req.query.includeInactive) ?? false;
  res.json({ units: await unitService.listUnits(scopeOf(req).businessId, includeInactive) });
});

export const createUnit = handler(async (req, res) => {
  const input = createUnitSchema.parse(req.body);
  res.status(201).json({ unit: await unitService.createUnit(scopeOf(req).businessId, input) });
});

export const updateUnit = handler(async (req, res) => {
  const patch = updateUnitSchema.parse(req.body);
  res.json({ unit: await unitService.updateUnit(scopeOf(req).businessId, req.params.unitId!, patch) });
});

// ---------------------------------------------------------------------------
// HSN
// ---------------------------------------------------------------------------

export const listHsn = handler(async (req, res) => {
  res.json({ hsnCodes: await hsnService.listHsnCodes(scopeOf(req).businessId) });
});

export const getHsn = handler(async (req, res) => {
  res.json({ hsnCode: await hsnService.getHsnCode(scopeOf(req).businessId, req.params.hsnId!) });
});

export const createHsn = handler(async (req, res) => {
  const input = createHsnSchema.parse(req.body);
  res.status(201).json({ hsnCode: await hsnService.createHsnCode(scopeOf(req).businessId, input) });
});

export const updateHsn = handler(async (req, res) => {
  const patch = updateHsnSchema.parse(req.body);
  res.json({
    hsnCode: await hsnService.updateHsnCode(scopeOf(req).businessId, req.params.hsnId!, patch),
  });
});

export const addHsnRate = handler(async (req, res) => {
  const input = addHsnRateSchema.parse(req.body);
  res.status(201).json({
    rate: await hsnService.addHsnRate(scopeOf(req).businessId, req.params.hsnId!, input),
  });
});

export const deleteHsnRate = handler(async (req, res) => {
  res.json(
    await hsnService.deleteHsnRate(scopeOf(req).businessId, req.params.hsnId!, req.params.rateId!),
  );
});

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export const listParties = handler(async (req, res) => {
  const filter = listPartiesQuerySchema.parse(req.query);
  res.json(await partyService.listParties(scopeOf(req).businessId, filter));
});

export const getParty = handler(async (req, res) => {
  res.json({ party: await partyService.getParty(scopeOf(req).businessId, req.params.partyId!) });
});

export const createParty = handler(async (req, res) => {
  const input = createPartySchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.status(201).json({
    party: await partyService.createParty(businessId, userId, input, contextOf(req)),
  });
});

export const updateParty = handler(async (req, res) => {
  const patch = updatePartySchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json({
    party: await partyService.updateParty(businessId, userId, req.params.partyId!, patch, contextOf(req)),
  });
});

export const getPartyLedger = handler(async (req, res) => {
  const options = dateRangeQuery.parse(req.query);
  res.json(await partyService.getPartyLedger(scopeOf(req).businessId, req.params.partyId!, options));
});

export const setPartyRate = handler(async (req, res) => {
  const input = setPartyRateSchema.parse(req.body);
  res.status(201).json({
    rate: await partyService.setPartyRate(scopeOf(req).businessId, req.params.partyId!, input),
  });
});

export const deletePartyRate = handler(async (req, res) => {
  res.json(
    await partyService.deletePartyRate(
      scopeOf(req).businessId,
      req.params.partyId!,
      req.params.rateId!,
    ),
  );
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const listProducts = handler(async (req, res) => {
  const filter = listProductsQuerySchema.parse(req.query);
  res.json(await productService.listProducts(scopeOf(req).businessId, filter));
});

export const getProduct = handler(async (req, res) => {
  res.json({ product: await productService.getProduct(scopeOf(req).businessId, req.params.productId!) });
});

export const createProduct = handler(async (req, res) => {
  const input = createProductSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.status(201).json({
    product: await productService.createProduct(businessId, userId, input, contextOf(req)),
  });
});

export const updateProduct = handler(async (req, res) => {
  const patch = updateProductSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json({
    product: await productService.updateProduct(
      businessId,
      userId,
      req.params.productId!,
      patch,
      contextOf(req),
    ),
  });
});

export const setProductUnit = handler(async (req, res) => {
  const input = setProductUnitSchema.parse(req.body);
  res.status(201).json({
    productUnit: await productService.setProductUnit(
      scopeOf(req).businessId,
      req.params.productId!,
      input,
    ),
  });
});

export const deleteProductUnit = handler(async (req, res) => {
  res.json(
    await productService.deleteProductUnit(
      scopeOf(req).businessId,
      req.params.productId!,
      req.params.unitId!,
    ),
  );
});

/// Shows the derived kg factor before it is saved — "1 kg = 0.4276 reams".
export const suggestKgConversion = handler(async (req, res) => {
  res.json(
    await productService.suggestKgConversion(scopeOf(req).businessId, req.params.productId!),
  );
});

export const setOpeningStock = handler(async (req, res) => {
  const input = openingStockSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json({
    product: await productService.setOpeningStock(businessId, userId, req.params.productId!, input),
  });
});

export const adjustStock = handler(async (req, res) => {
  const input = adjustStockSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json(
    await productService.adjustStock(businessId, userId, req.params.productId!, input, contextOf(req)),
  );
});

export const getStockHistory = handler(async (req, res) => {
  const options = dateRangeQuery.parse(req.query);
  res.json(
    await productService.getStockHistory(scopeOf(req).businessId, req.params.productId!, options),
  );
});
