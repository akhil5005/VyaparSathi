import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_EDIT_MASTERS, CAN_SEE_COST } from '../../middleware/authorize.js';
import * as c from './purchase.controller.js';

export const purchaseRouter = Router();

purchaseRouter.use(authenticate);

// Purchases expose supplier pricing and landed cost, so counter staff are kept
// out entirely — this is not the same read tier as sales.
const canSeePurchases = authorize(...CAN_SEE_COST);
const canEdit = authorize(...CAN_EDIT_MASTERS);

// ---- Reports (literal paths before /:purchaseId) ----
purchaseRouter.get('/gst-summary', canSeePurchases, c.gstSummary);
purchaseRouter.get('/itc/pending', canSeePurchases, c.pendingItc);
purchaseRouter.post('/itc/claim', canEdit, c.claimItc);
purchaseRouter.get('/by-product/:productId', canSeePurchases, c.productHistory);

// ---- Purchases ----
purchaseRouter.get('/', canSeePurchases, c.list);
purchaseRouter.post('/preview', canEdit, c.preview);
purchaseRouter.post('/', canEdit, c.create);
purchaseRouter.get('/:purchaseId', canSeePurchases, c.getOne);
purchaseRouter.post('/:purchaseId/cancel', canEdit, c.cancel);
purchaseRouter.post('/:purchaseId/unclaim-itc', canEdit, c.unclaimItc);
