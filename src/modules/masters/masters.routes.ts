import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_BILL, CAN_EDIT_MASTERS, CAN_VIEW } from '../../middleware/authorize.js';
import * as c from './masters.controller.js';

export const mastersRouter = Router();

mastersRouter.use(authenticate);

const canView = authorize(...CAN_VIEW);
const canEdit = authorize(...CAN_EDIT_MASTERS);

// ---- Units ----
mastersRouter.get('/units', canView, c.listUnits);
mastersRouter.post('/units', canEdit, c.createUnit);
mastersRouter.patch('/units/:unitId', canEdit, c.updateUnit);

// ---- HSN codes and their rate history ----
mastersRouter.get('/hsn', canView, c.listHsn);
mastersRouter.post('/hsn', canEdit, c.createHsn);
mastersRouter.get('/hsn/:hsnId', canView, c.getHsn);
mastersRouter.patch('/hsn/:hsnId', canEdit, c.updateHsn);
mastersRouter.post('/hsn/:hsnId/rates', canEdit, c.addHsnRate);
mastersRouter.delete('/hsn/:hsnId/rates/:rateId', canEdit, c.deleteHsnRate);

// ---- Parties ----
mastersRouter.get('/parties', canView, c.listParties);
// Billing staff can add a walk-in customer mid-sale; they still cannot edit one.
mastersRouter.post('/parties', authorize(...CAN_BILL), c.createParty);
mastersRouter.get('/parties/:partyId', canView, c.getParty);
mastersRouter.patch('/parties/:partyId', canEdit, c.updateParty);
mastersRouter.get('/parties/:partyId/ledger', canView, c.getPartyLedger);
mastersRouter.post('/parties/:partyId/rates', canEdit, c.setPartyRate);
mastersRouter.delete('/parties/:partyId/rates/:rateId', canEdit, c.deletePartyRate);

// ---- Products ----
mastersRouter.get('/products', canView, c.listProducts);
mastersRouter.post('/products', canEdit, c.createProduct);
mastersRouter.get('/products/:productId', canView, c.getProduct);
mastersRouter.patch('/products/:productId', canEdit, c.updateProduct);

// Units and conversions — the reams↔kg bridge
mastersRouter.get('/products/:productId/kg-conversion', canView, c.suggestKgConversion);
mastersRouter.post('/products/:productId/units', canEdit, c.setProductUnit);
mastersRouter.delete('/products/:productId/units/:unitId', canEdit, c.deleteProductUnit);

// Stock
mastersRouter.get('/products/:productId/stock-history', canView, c.getStockHistory);
mastersRouter.post('/products/:productId/opening-stock', canEdit, c.setOpeningStock);
mastersRouter.post('/products/:productId/adjust-stock', canEdit, c.adjustStock);
