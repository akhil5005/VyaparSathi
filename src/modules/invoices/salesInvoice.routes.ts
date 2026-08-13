import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_BILL, CAN_EDIT_MASTERS, CAN_VIEW } from '../../middleware/authorize.js';
import * as controller from './salesInvoice.controller.js';

export const salesInvoiceRouter = Router();

salesInvoiceRouter.use(authenticate);

// Reads
salesInvoiceRouter.get('/', authorize(...CAN_VIEW), controller.list);
salesInvoiceRouter.get('/next-number', authorize(...CAN_VIEW), controller.nextNumber);
salesInvoiceRouter.get('/:invoiceId', authorize(...CAN_VIEW), controller.getOne);

// Dry run — full computation, nothing written. Used by the invoice form and by
// the voice confirmation card.
salesInvoiceRouter.post('/preview', authorize(...CAN_BILL), controller.preview);

// Writes
salesInvoiceRouter.post('/', authorize(...CAN_BILL), controller.create);
salesInvoiceRouter.post('/:invoiceId/issue', authorize(...CAN_BILL), controller.issue);

// Cancelling an issued invoice reverses stock and ledger — owner/manager only.
salesInvoiceRouter.post('/:invoiceId/cancel', authorize(...CAN_EDIT_MASTERS), controller.cancel);
