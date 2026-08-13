import type { Request, RequestHandler, Response } from 'express';
import { CAN_SEE_COST } from '../../middleware/authorize.js';
import { currentFinancialYear } from '../../lib/financialYear.js';
import { prisma } from '../../lib/prisma.js';
import { peekDocumentNumber } from './numbering.js';
import * as service from './salesInvoice.service.js';
import {
  cancelInvoiceSchema,
  createSalesInvoiceSchema,
  listInvoicesQuerySchema,
  previewSalesInvoiceSchema,
} from './salesInvoice.schemas.js';

const contextOf = (req: Request) => ({
  ipAddress: req.ip,
  userAgent: req.get('user-agent') ?? undefined,
});

const handler =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/// Cost price and margin are owner/manager/accountant information. Billing
/// staff can create the invoice but must not see what the goods cost.
function stripCost<T extends Record<string, unknown>>(invoice: T, role: string): T {
  if (CAN_SEE_COST.includes(role as never)) return invoice;
  const { costOfGoods, items, ...rest } = invoice as Record<string, unknown>;
  return {
    ...rest,
    ...(Array.isArray(items)
      ? {
          items: items.map((item) => {
            const { costPerBaseUnit, ...line } = item as Record<string, unknown>;
            return line;
          }),
        }
      : {}),
  } as T;
}

export const preview = handler(async (req, res) => {
  const input = previewSalesInvoiceSchema.parse(req.body);
  const result = await service.previewSalesInvoice(req.auth!.businessId, input);
  res.json(result);
});

export const create = handler(async (req, res) => {
  const input = createSalesInvoiceSchema.parse(req.body);
  const { invoice, warnings, hsnSummary } = await service.createSalesInvoice(
    req.auth!.businessId,
    req.auth!.userId,
    input,
    contextOf(req),
  );

  res.status(201).json({
    invoice: stripCost(invoice as unknown as Record<string, unknown>, req.auth!.role),
    hsnSummary,
    warnings,
  });
});

export const issue = handler(async (req, res) => {
  const { invoice, warnings } = await service.issueDraft(
    req.auth!.businessId,
    req.auth!.userId,
    req.params.invoiceId!,
    contextOf(req),
  );
  res.json({
    invoice: stripCost(invoice as unknown as Record<string, unknown>, req.auth!.role),
    warnings,
  });
});

export const cancel = handler(async (req, res) => {
  const { reason } = cancelInvoiceSchema.parse(req.body);
  const result = await service.cancelSalesInvoice(
    req.auth!.businessId,
    req.auth!.userId,
    req.params.invoiceId!,
    reason,
    contextOf(req),
  );
  res.json(result);
});

export const getOne = handler(async (req, res) => {
  const invoice = await service.getSalesInvoice(req.auth!.businessId, req.params.invoiceId!);
  res.json({ invoice: stripCost(invoice as unknown as Record<string, unknown>, req.auth!.role) });
});

export const list = handler(async (req, res) => {
  const filter = listInvoicesQuerySchema.parse(req.query);
  res.json(await service.listSalesInvoices(req.auth!.businessId, filter));
});

/// What the "new invoice" screen shows in the number field before saving.
/// Peeking does not consume the number.
export const nextNumber = handler(async (req, res) => {
  const business = await prisma.business.findUnique({
    where: { id: req.auth!.businessId },
    select: { fyStartMonth: true },
  });
  const financialYear = currentFinancialYear(business?.fyStartMonth ?? 4);
  const number = await peekDocumentNumber(
    prisma,
    req.auth!.businessId,
    'SALES_INVOICE',
    financialYear,
  );
  res.json({ financialYear, nextNumber: number });
});
