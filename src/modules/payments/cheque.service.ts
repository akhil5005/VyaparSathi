import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { D } from '../../lib/money.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { RequestContext } from '../auth/auth.service.js';
import { applyReversal } from './payment.service.js';
import type { listChequesQuerySchema } from './payment.schemas.js';
import type { Numeric } from '../../lib/money.js';

type ListChequesFilter = z.infer<typeof listChequesQuerySchema>;

export interface BounceInput {
  reason: string;
  /// Bank charges recovered from the party, posted to their ledger.
  bounceCharges?: Numeric;
  bouncedOn?: Date;
}

/**
 * Cheque lifecycle: PENDING → DEPOSITED → CLEARED, or → BOUNCED.
 *
 * The money is posted to the ledger when the cheque is *received*, not when it
 * clears — that matches how the trade actually accounts for it, and it is why a
 * bounce has to reverse rather than simply mark a flag. If you would rather not
 * recognise a post-dated cheque until it is banked, don't record the payment
 * until then; the `chequeDate` field keeps it visible on the due list either way.
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'],
  DEPOSITED: ['CLEARED', 'BOUNCED'],
  CLEARED: [],
  BOUNCED: ['DEPOSITED'], // re-presented after the party asks you to try again
  CANCELLED: [],
};

async function loadCheque(businessId: string, chequeId: string) {
  const cheque = await prisma.cheque.findFirst({
    where: { id: chequeId, businessId },
    include: { payment: true, party: { select: { displayName: true } } },
  });
  if (!cheque) throw notFound('Cheque not found');
  return cheque;
}

function assertTransition(from: string, to: string) {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`A ${from.toLowerCase()} cheque cannot be marked ${to.toLowerCase()}`);
  }
}

export async function depositCheque(businessId: string, chequeId: string, onDate?: Date) {
  const cheque = await loadCheque(businessId, chequeId);
  assertTransition(cheque.status, 'DEPOSITED');

  return prisma.cheque.update({
    where: { id: chequeId },
    data: { status: 'DEPOSITED', depositedAt: onDate ?? new Date() },
  });
}

/**
 * Clearance touches no money. The ledger was already posted when the cheque was
 * received, so clearing simply confirms it — the alternative would double-count.
 */
export async function clearCheque(businessId: string, chequeId: string, onDate?: Date) {
  const cheque = await loadCheque(businessId, chequeId);
  assertTransition(cheque.status, 'CLEARED');

  return prisma.cheque.update({
    where: { id: chequeId },
    data: { status: 'CLEARED', clearedAt: onDate ?? new Date(), bounceReason: null },
  });
}

export async function cancelCheque(businessId: string, chequeId: string) {
  const cheque = await loadCheque(businessId, chequeId);
  assertTransition(cheque.status, 'CANCELLED');
  if (cheque.payment && !cheque.payment.reversedAt) {
    throw badRequest(
      'A cheque with a live payment cannot be cancelled. Reverse the payment instead.',
    );
  }
  return prisma.cheque.update({ where: { id: chequeId }, data: { status: 'CANCELLED' } });
}

/**
 * Marks a cheque returned and undoes everything it paid for.
 *
 * The invoices it settled reopen, the party's balance goes back up, and any
 * bank charge is added to what they owe. The original payment row survives with
 * `reversedAt` set — the books must still show that a cheque was taken and
 * came back.
 */
export async function bounceCheque(
  businessId: string,
  userId: string,
  chequeId: string,
  input: BounceInput,
  ctx: RequestContext,
) {
  const cheque = await loadCheque(businessId, chequeId);
  assertTransition(cheque.status, 'BOUNCED');

  const bouncedOn = input.bouncedOn ?? new Date();
  const charges = input.bounceCharges ? D(input.bounceCharges) : undefined;

  return prisma.$transaction(
    async (tx) => {
      const updated = await tx.cheque.update({
        where: { id: chequeId },
        data: {
          status: 'BOUNCED',
          bouncedAt: bouncedOn,
          bounceReason: input.reason,
          bounceCharges: charges ?? null,
        },
      });

      // A cheque recorded without a payment (rare, but possible if it was
      // entered as a pure tracking row) has nothing to reverse.
      if (cheque.payment && !cheque.payment.reversedAt) {
        await applyReversal(tx, {
          businessId,
          userId,
          paymentId: cheque.payment.id,
          reason: `Cheque ${cheque.chequeNumber} returned: ${input.reason}`,
          extraCharge: charges,
          onDate: bouncedOn,
          voucherType: 'CHEQUE_BOUNCE',
        });
      }

      await tx.auditLog.create({
        data: {
          businessId,
          userId,
          action: 'cheque.bounce',
          entityType: 'Cheque',
          entityId: chequeId,
          after: {
            chequeNumber: cheque.chequeNumber,
            party: cheque.party.displayName,
            amount: cheque.amount.toString(),
            reason: input.reason,
            charges: charges?.toString() ?? null,
          },
          ipAddress: ctx.ipAddress ?? null,
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 },
  );
}

/**
 * Cheques on hand. `dueBy` answers the question that actually gets asked every
 * Monday: which post-dated cheques can I bank this week?
 */
export async function listCheques(businessId: string, filter: ListChequesFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const where: Prisma.ChequeWhereInput = {
    businessId,
    ...(filter.partyId ? { partyId: filter.partyId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.direction ? { direction: filter.direction } : {}),
    ...(filter.dueBy ? { chequeDate: { lte: filter.dueBy }, status: 'PENDING' } : {}),
  };

  const [rows, total, totals] = await Promise.all([
    prisma.cheque.findMany({
      where,
      include: {
        party: { select: { id: true, displayName: true, phone: true } },
        payment: { select: { id: true, voucherNumber: true, reversedAt: true } },
      },
      orderBy: [{ chequeDate: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.cheque.count({ where }),
    prisma.cheque.aggregate({ where, _sum: { amount: true } }),
  ]);

  const today = new Date();
  return {
    cheques: rows.map((c) => ({
      ...c,
      /// Post-dated cheques cannot be banked yet — surfacing this stops a
      /// pointless trip to the bank.
      bankable: c.status === 'PENDING' && c.chequeDate <= today,
    })),
    total,
    page,
    pageSize,
    totalAmount: D(totals._sum.amount ?? 0),
  };
}

export async function getCheque(businessId: string, chequeId: string) {
  return loadCheque(businessId, chequeId);
}
