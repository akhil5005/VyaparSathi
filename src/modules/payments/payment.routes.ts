import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import {
  authorize,
  CAN_EDIT_MASTERS,
  CAN_RECEIVE_PAYMENT,
  CAN_VIEW,
} from '../../middleware/authorize.js';
import * as c from './payment.controller.js';

export const paymentRouter = Router();

paymentRouter.use(authenticate);

const canView = authorize(...CAN_VIEW);
const canReceive = authorize(...CAN_RECEIVE_PAYMENT);
// Reversing a payment and bouncing a cheque both move money back out of the
// books, so they sit with the owner/manager rather than counter staff.
const canReverse = authorize(...CAN_EDIT_MASTERS);

// ---- Reports ----
paymentRouter.get('/outstanding', canView, c.outstanding);

// ---- Cheques (before /:paymentId so the literal path wins) ----
paymentRouter.get('/cheques', canView, c.listCheques);
paymentRouter.get('/cheques/:chequeId', canView, c.getCheque);
paymentRouter.post('/cheques/:chequeId/deposit', canReceive, c.depositCheque);
paymentRouter.post('/cheques/:chequeId/clear', canReceive, c.clearCheque);
paymentRouter.post('/cheques/:chequeId/bounce', canReverse, c.bounceCheque);
paymentRouter.post('/cheques/:chequeId/cancel', canReverse, c.cancelCheque);

// ---- Payments ----
paymentRouter.get('/', canView, c.list);
paymentRouter.post('/', canReceive, c.record);
paymentRouter.get('/:paymentId', canView, c.getOne);
paymentRouter.post('/:paymentId/allocate', canReceive, c.allocate);
paymentRouter.delete('/:paymentId/allocations/:allocationId', canReceive, c.unallocate);
paymentRouter.post('/:paymentId/reverse', canReverse, c.reverse);
