import { z } from 'zod';
import { contextOf, handler, scopeOf } from '../../lib/http.js';
import * as paymentService from './payment.service.js';
import * as chequeService from './cheque.service.js';
import {
  allocatePaymentSchema,
  bounceChequeSchema,
  listChequesQuerySchema,
  listPaymentsQuerySchema,
  outstandingQuerySchema,
  recordPaymentSchema,
  reversePaymentSchema,
} from './payment.schemas.js';

const onDateSchema = z.object({ onDate: z.coerce.date().optional() });

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const record = handler(async (req, res) => {
  const input = recordPaymentSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.status(201).json(await paymentService.recordPayment(businessId, userId, input, contextOf(req)));
});

export const list = handler(async (req, res) => {
  const filter = listPaymentsQuerySchema.parse(req.query);
  res.json(await paymentService.listPayments(scopeOf(req).businessId, filter));
});

export const getOne = handler(async (req, res) => {
  res.json({ payment: await paymentService.getPayment(scopeOf(req).businessId, req.params.paymentId!) });
});

export const allocate = handler(async (req, res) => {
  const input = allocatePaymentSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json(
    await paymentService.allocateExistingPayment(
      businessId,
      userId,
      req.params.paymentId!,
      input,
      contextOf(req),
    ),
  );
});

export const unallocate = handler(async (req, res) => {
  const { businessId, userId } = scopeOf(req);
  res.json(
    await paymentService.removeAllocation(
      businessId,
      userId,
      req.params.paymentId!,
      req.params.allocationId!,
      contextOf(req),
    ),
  );
});

export const reverse = handler(async (req, res) => {
  const { reason } = reversePaymentSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json(
    await paymentService.reversePayment(businessId, userId, req.params.paymentId!, reason, contextOf(req)),
  );
});

/// The udhaar report — who owes what, bucketed by age.
export const outstanding = handler(async (req, res) => {
  const filter = outstandingQuerySchema.parse(req.query);
  res.json(await paymentService.getOutstanding(scopeOf(req).businessId, filter));
});

// ---------------------------------------------------------------------------
// Cheques
// ---------------------------------------------------------------------------

export const listCheques = handler(async (req, res) => {
  const filter = listChequesQuerySchema.parse(req.query);
  res.json(await chequeService.listCheques(scopeOf(req).businessId, filter));
});

export const getCheque = handler(async (req, res) => {
  res.json({ cheque: await chequeService.getCheque(scopeOf(req).businessId, req.params.chequeId!) });
});

export const depositCheque = handler(async (req, res) => {
  const { onDate } = onDateSchema.parse(req.body ?? {});
  res.json({
    cheque: await chequeService.depositCheque(scopeOf(req).businessId, req.params.chequeId!, onDate),
  });
});

export const clearCheque = handler(async (req, res) => {
  const { onDate } = onDateSchema.parse(req.body ?? {});
  res.json({
    cheque: await chequeService.clearCheque(scopeOf(req).businessId, req.params.chequeId!, onDate),
  });
});

export const bounceCheque = handler(async (req, res) => {
  const input = bounceChequeSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json({
    cheque: await chequeService.bounceCheque(businessId, userId, req.params.chequeId!, input, contextOf(req)),
  });
});

export const cancelCheque = handler(async (req, res) => {
  res.json({
    cheque: await chequeService.cancelCheque(scopeOf(req).businessId, req.params.chequeId!),
  });
});
