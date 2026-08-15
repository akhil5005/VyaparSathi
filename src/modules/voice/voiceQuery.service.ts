import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { D } from '../../lib/money.js';
import { extractor } from '../../lib/anthropic.js';
import { badRequestCoded } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { rank } from '../ai/match.js';
import { formatIndianNumber, formatQuantity, formatDate } from '../printing/format.js';
import { digitizeNumbers } from './punjabiNumbers.js';
import { PERIOD_NAMES, resolvePeriod, type PeriodName } from './period.js';
import { transcriber, type AudioClip } from './asr.js';

/**
 * Asking the shop a question out loud, and getting an answer back.
 *
 * This is the read-only half of voice, and it ships first deliberately: it is
 * immediately useful at a counter with both hands full, it exposes how well the
 * speech engine copes with the way this shop actually talks, and — the part
 * that matters — it cannot damage anything while we find that out. Billing by
 * voice is only worth building once this is reliably understanding them.
 *
 * Four rules, each of which the code enforces rather than hopes for:
 *
 *  1. **Nothing is written.** Every query below is a read. There is no write
 *     path here to get out of sync with the forms, because there is no write.
 *  2. **The model picks; it does not invent.** It is handed a shortlist of
 *     candidate parties and products, matched deterministically from the
 *     transcript, and may only return an id that appears on that list. An id
 *     from anywhere else is discarded.
 *  3. **The model never states a figure.** It decides what was asked; the
 *     answer sentence is composed here from the database. A model that can
 *     phrase the number can get the number wrong, and a confidently wrong
 *     balance read aloud is worse than no feature.
 *  4. **Ambiguity is offered, not resolved.** Two similarly named customers
 *     produce a choice on screen, not a coin flip.
 */

export const INTENTS = [
  'PARTY_BALANCE',
  'PRODUCT_STOCK',
  'PRODUCT_RATE',
  'SALES_TOTAL',
  'PURCHASES_TOTAL',
  'RECEIVABLES_TOTAL',
  'PAYABLES_TOTAL',
  'PARTY_LAST_INVOICE',
  'UNKNOWN',
] as const;

export type QueryIntent = (typeof INTENTS)[number];

export interface Shortlist {
  parties: { id: string; displayName: string; score: number }[];
  products: { id: string; name: string; score: number }[];
}

export interface Intent {
  intent: QueryIntent;
  partyId: string | null;
  productId: string | null;
  period: PeriodName | null;
  /// 0–1, as reported by the model. Only used to decide whether to offer choices.
  confidence: number;
  reasoning: string;
}

export interface VoiceAnswer {
  /// The words as heard, before the number parser touched them.
  heard: string;
  /// The same words with spoken numerals turned into digits.
  understood: string;
  intent: QueryIntent;
  /// One sentence, composed from the database — never by the model.
  answer: string;
  details: { label: string; value: string }[];
  /// Shown when the question named someone or something ambiguously.
  choices: { kind: 'party' | 'product'; options: { id: string; name: string }[] } | null;
  confidence: number;
  reasoning: string | null;
  engine: string | null;
}

// ---------------------------------------------------------------------------
// Step ①–③: heard words to a shortlist
// ---------------------------------------------------------------------------

/**
 * Which parties and products the utterance could plausibly be about.
 *
 * The point of doing this here rather than handing Claude the whole catalogue
 * is not cost, it is correctness: a model given six hundred product names will
 * eventually return one that sounds right and isn't. Given four, it can only be
 * wrong in ways the operator can see.
 *
 * The floor is lower than the bill scanner's because speech is messier than
 * print — a name half-swallowed on a shop floor still deserves to be offered as
 * a choice.
 */
export async function shortlistFor(businessId: string, utterance: string): Promise<Shortlist> {
  const [parties, products] = await Promise.all([
    prisma.party.findMany({
      where: { businessId, isActive: true },
      select: { id: true, displayName: true, legalName: true },
    }),
    prisma.product.findMany({
      where: { businessId, isActive: true },
      select: { id: true, name: true, aliasNames: true },
    }),
  ]);

  return {
    parties: rank(utterance, parties, (p) => [p.displayName, p.legalName ?? ''], {
      limit: 4,
      floor: 0.3,
    }).map((c) => ({ id: c.item.id, displayName: c.item.displayName, score: round2(c.score) })),
    products: rank(utterance, products, (p) => [p.name, ...(p.aliasNames ?? [])], {
      limit: 4,
      floor: 0.3,
    }).map((c) => ({ id: c.item.id, name: c.item.name, score: round2(c.score) })),
  };
}

const round2 = (value: number) => Number(value.toFixed(2));

// ---------------------------------------------------------------------------
// Step ④: what was being asked
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENTS], description: 'What is being asked' },
    partyId: {
      type: 'string',
      description: 'Id copied exactly from the candidate customers list. Omit if none fits.',
    },
    productId: {
      type: 'string',
      description: 'Id copied exactly from the candidate products list. Omit if none fits.',
    },
    period: { type: 'string', enum: [...PERIOD_NAMES], description: 'Only for totals' },
    confidence: { type: 'number', description: '0 to 1' },
    reasoning: { type: 'string', description: 'One short sentence, in English' },
  },
  required: ['intent', 'confidence', 'reasoning'],
} as const;

const SYSTEM = [
  'You interpret spoken questions from the owner of a paper shop in Punjab, India.',
  'He speaks Punjabi mixed with Hindi and English words, transcribed roughly, often',
  'with the wrong spelling. Your only job is to decide which question is being asked',
  'and which customer or product it is about.',
  '',
  'The intents:',
  '- PARTY_BALANCE: how much a party owes, or is owed. "kinna paisa dena hai", "balance".',
  '- PRODUCT_STOCK: how much of an item is in the godown. "kinna stock", "kitne ream pae ne".',
  '- PRODUCT_RATE: what an item last sold for, optionally to a particular party.',
  '- SALES_TOTAL: sales over a period. "aj di sale", "is mahine di sale".',
  '- PURCHASES_TOTAL: purchases over a period.',
  '- RECEIVABLES_TOTAL: total owed to the shop by everyone.',
  '- PAYABLES_TOTAL: total the shop owes to everyone.',
  '- PARTY_LAST_INVOICE: the most recent bill made out to a party.',
  '- UNKNOWN: anything else, including anything asking you to change or record something.',
  '',
  'Rules:',
  '- partyId and productId must be copied character for character from the candidate',
  '  lists given to you. Never write an id that is not on a list. If nothing on the',
  '  list is plainly the one being spoken about, omit the field.',
  '- Never state or estimate an amount, a balance or a quantity. You are not given',
  '  those figures and you must not invent them; the application looks them up.',
  '- This is a read-only assistant. If the speaker is trying to create a bill, record',
  '  a payment or change anything, the intent is UNKNOWN.',
  '- confidence is about whether you understood the question and picked the right',
  '  party or product. Be honest and low when the transcript is garbled.',
].join('\n');

/**
 * Anything the model returns that we did not offer it is discarded.
 *
 * Separated from the network call so the rule can be tested directly, because
 * this is the guard that stops a hallucinated id becoming a lookup against
 * another shop's data. It is cheap and it is the difference between "the model
 * chooses from a list" and "the model is trusted".
 */
export function validateIntent(raw: unknown, list: Shortlist): Intent {
  const value = (raw ?? {}) as Record<string, unknown>;

  const intent = (INTENTS as readonly string[]).includes(String(value.intent))
    ? (value.intent as QueryIntent)
    : 'UNKNOWN';

  const partyId = list.parties.some((p) => p.id === value.partyId)
    ? (value.partyId as string)
    : null;
  const productId = list.products.some((p) => p.id === value.productId)
    ? (value.productId as string)
    : null;

  const period = (PERIOD_NAMES as readonly string[]).includes(String(value.period))
    ? (value.period as PeriodName)
    : null;

  const confidence =
    typeof value.confidence === 'number' && value.confidence >= 0 && value.confidence <= 1
      ? value.confidence
      : 0;

  return {
    intent,
    partyId,
    productId,
    period,
    confidence,
    reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
  };
}

async function interpret(utterance: string, list: Shortlist): Promise<Intent> {
  const candidates = [
    'Candidate customers and suppliers:',
    list.parties.length
      ? list.parties.map((p) => `  ${p.id}  ${p.displayName}`).join('\n')
      : '  (none matched)',
    '',
    'Candidate products:',
    list.products.length
      ? list.products.map((p) => `  ${p.id}  ${p.name}`).join('\n')
      : '  (none matched)',
  ].join('\n');

  const result = await extractor.extract<unknown>({
    system: SYSTEM,
    prompt: `${candidates}\n\nThe question, as heard:\n"${utterance}"`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1024,
  });

  if (!result.ok) {
    logger.error({ reason: result.reason }, 'Voice intent extraction failed');
    throw badRequestCoded(
      'AI_UNAVAILABLE',
      'The question could not be worked out just now. Try again, or look it up on the screen.',
    );
  }

  return validateIntent(result.value, list);
}

// ---------------------------------------------------------------------------
// Step ⑤: the answer, built from the database
// ---------------------------------------------------------------------------

const rupees = (value: Prisma.Decimal.Value) => `₹${formatIndianNumber(value)}`;

/**
 * Below this the model is telling us it is guessing, so the answer offers the
 * shortlist instead of acting on the guess. A wrong customer's balance read out
 * at a counter is a real-world embarrassment; one extra tap is not.
 */
const CONFIDENT = 0.6;

export interface AnswerOptions {
  now?: Date;
  /**
   * Whether this user may hear cost figures.
   *
   * Billing staff can raise an invoice but must not see what the goods cost —
   * the same rule `stripCost` enforces on the invoice API. A spoken channel is
   * not a way around it, and the cheapest way to be sure of that is to make the
   * permission an argument this function cannot answer without.
   */
  canSeeCost?: boolean;
}

export async function answerIntent(
  businessId: string,
  intent: Intent,
  list: Shortlist,
  options: AnswerOptions = {},
): Promise<Omit<VoiceAnswer, 'heard' | 'understood' | 'engine'>> {
  const { now = new Date(), canSeeCost = false } = options;
  const base = {
    intent: intent.intent,
    confidence: intent.confidence,
    reasoning: intent.reasoning || null,
    choices: null,
    details: [] as { label: string; value: string }[],
  };

  const needsParty = (): VoiceAnswer['choices'] =>
    list.parties.length
      ? {
          kind: 'party' as const,
          options: list.parties.map((p) => ({ id: p.id, name: p.displayName })),
        }
      : null;

  const needsProduct = (): VoiceAnswer['choices'] =>
    list.products.length
      ? { kind: 'product' as const, options: list.products.map((p) => ({ id: p.id, name: p.name })) }
      : null;

  const unsure = intent.confidence < CONFIDENT;

  switch (intent.intent) {
    case 'PARTY_BALANCE': {
      if (!intent.partyId || unsure) {
        return {
          ...base,
          answer: 'Which account was that? Pick the one you meant.',
          choices: needsParty(),
        };
      }

      const party = await prisma.party.findFirst({
        where: { id: intent.partyId, businessId },
        include: { balance: { select: { currentBalance: true, lastEntryAt: true } } },
      });
      if (!party) return { ...base, answer: 'That account is no longer on file.' };

      const balance = D(party.balance?.currentBalance ?? 0);
      // Positive means the party owes us; negative means we owe them. Saying it
      // the wrong way round is the single worst mistake this feature could make,
      // so it is spelled out in words rather than shown as a signed number.
      const answer = balance.isZero()
        ? `${party.displayName} is settled — nothing outstanding either way.`
        : balance.greaterThan(0)
          ? `${party.displayName} owes you ${rupees(balance)}.`
          : `You owe ${party.displayName} ${rupees(balance.abs())}.`;

      return {
        ...base,
        answer,
        details: [
          { label: 'Account', value: party.displayName },
          {
            label: 'Last entry',
            value: party.balance?.lastEntryAt ? formatDate(party.balance.lastEntryAt) : 'none yet',
          },
          ...(party.creditLimit
            ? [{ label: 'Credit limit', value: rupees(party.creditLimit) }]
            : []),
        ],
      };
    }

    case 'PRODUCT_STOCK': {
      if (!intent.productId || unsure) {
        return {
          ...base,
          answer: 'Which item was that? Pick the one you meant.',
          choices: needsProduct(),
        };
      }

      const product = await prisma.product.findFirst({
        where: { id: intent.productId, businessId },
        include: { baseUnit: { select: { symbol: true } } },
      });
      if (!product) return { ...base, answer: 'That item is no longer on file.' };

      const stock = await prisma.productStock.findUnique({
        where: { productId: product.id },
        select: { quantityOnHand: true, avgCostPerBaseUnit: true, lastMovementAt: true },
      });

      const onHand = D(stock?.quantityOnHand ?? 0);
      const unit = product.baseUnit.symbol;
      const answer = onHand.isZero()
        ? `There is no ${product.name} in stock.`
        : onHand.isNegative()
          ? `${product.name} shows ${formatQuantity(onHand)} ${unit} — the stock has gone negative, so something was billed that was never entered as a purchase.`
          : `${formatQuantity(onHand)} ${unit} of ${product.name} in stock.`;

      return {
        ...base,
        answer,
        details: [
          { label: 'Item', value: product.name },
          ...(canSeeCost
            ? [
                {
                  label: 'Stock value at average cost',
                  value: rupees(onHand.times(D(stock?.avgCostPerBaseUnit ?? 0))),
                },
              ]
            : []),
          ...(product.reorderLevel && onHand.lessThanOrEqualTo(D(product.reorderLevel))
            ? [{ label: 'Reorder level', value: `${formatQuantity(product.reorderLevel)} ${unit} — at or below it` }]
            : []),
          {
            label: 'Last movement',
            value: stock?.lastMovementAt ? formatDate(stock.lastMovementAt) : 'none yet',
          },
        ],
      };
    }

    case 'PRODUCT_RATE': {
      if (!intent.productId || unsure) {
        return {
          ...base,
          answer: 'Which item was that? Pick the one you meant.',
          choices: needsProduct(),
        };
      }

      const product = await prisma.product.findFirst({
        where: { id: intent.productId, businessId },
        select: { id: true, name: true, defaultSaleRate: true },
      });
      if (!product) return { ...base, answer: 'That item is no longer on file.' };

      /**
       * What it last actually went out at, not what the price list says.
       *
       * The rate that matters when a customer is standing there asking is the
       * one you gave them last time — the default is a starting point that may
       * be months stale. Scoped to the party when one was named, because a
       * regular's price is not the walk-in price.
       */
      const lastSale = await prisma.salesInvoiceItem.findFirst({
        where: {
          productId: product.id,
          invoice: {
            businessId,
            status: 'ISSUED',
            ...(intent.partyId ? { partyId: intent.partyId } : {}),
          },
        },
        orderBy: { invoice: { invoiceDate: 'desc' } },
        select: {
          rate: true,
          unitName: true,
          invoice: { select: { invoiceDate: true, partyName: true, invoiceNumber: true } },
        },
      });

      if (!lastSale) {
        return {
          ...base,
          answer: product.defaultSaleRate
            ? `${product.name} has not been sold yet. The price list says ${rupees(product.defaultSaleRate)}.`
            : `${product.name} has not been sold yet, and no default rate is set for it.`,
          details: [{ label: 'Item', value: product.name }],
        };
      }

      return {
        ...base,
        answer: `${product.name} last went out at ${rupees(lastSale.rate)} per ${lastSale.unitName}, to ${lastSale.invoice.partyName} on ${formatDate(lastSale.invoice.invoiceDate)}.`,
        details: [
          { label: 'Bill', value: lastSale.invoice.invoiceNumber ?? '—' },
          ...(product.defaultSaleRate
            ? [{ label: 'Price list', value: rupees(product.defaultSaleRate) }]
            : []),
        ],
      };
    }

    case 'SALES_TOTAL':
    case 'PURCHASES_TOTAL': {
      const sales = intent.intent === 'SALES_TOTAL';
      // What was paid to suppliers is cost information, and the purchase API is
      // already closed to billing staff. Answering it aloud would be a hole.
      if (!sales && !canSeeCost) {
        return { ...base, answer: 'Purchase figures are not something this account can see.' };
      }
      // A question with no period named is about today at a counter, and about
      // the month in an office. Today is the safer read: it is the smaller
      // claim, and the answer says which days it counted either way.
      const period = resolvePeriod(intent.period ?? 'TODAY', now);

      const totals = sales
        ? await prisma.salesInvoice.aggregate({
            where: {
              businessId,
              status: 'ISSUED',
              invoiceDate: { gte: period.fromDate, lte: period.toDate },
            },
            _count: true,
            _sum: { grandTotal: true, taxableValue: true },
          })
        : await prisma.purchaseInvoice.aggregate({
            where: {
              businessId,
              status: 'ISSUED',
              supplierInvoiceDate: { gte: period.fromDate, lte: period.toDate },
            },
            _count: true,
            _sum: { grandTotal: true, taxableValue: true },
          });

      const total = D(totals._sum.grandTotal ?? 0);
      const word = sales ? 'Sales' : 'Purchases';
      const noun = sales ? 'bills' : 'bills entered';

      return {
        ...base,
        answer: totals._count
          ? `${word} ${period.label}: ${rupees(total)} across ${totals._count} ${totals._count === 1 ? noun.replace(/s\b/, '') : noun}.`
          : `No ${sales ? 'sales' : 'purchases'} ${period.label}.`,
        details: [
          { label: 'Period', value: `${formatDate(period.fromDate)} to ${formatDate(period.toDate)}` },
          { label: 'Before tax', value: rupees(D(totals._sum.taxableValue ?? 0)) },
        ],
      };
    }

    case 'RECEIVABLES_TOTAL':
    case 'PAYABLES_TOTAL': {
      const owedToUs = intent.intent === 'RECEIVABLES_TOTAL';

      /**
       * Summed over balances rather than over unpaid invoices.
       *
       * `PartyBalance` is the figure the ledger screens show and the one the
       * shop reconciles against. Recomputing it a second way here would give
       * two different answers to the same question — and the one spoken aloud
       * would be the one nobody could trace.
       */
      const balances = await prisma.partyBalance.findMany({
        where: {
          party: { businessId, isActive: true },
          currentBalance: owedToUs ? { gt: 0 } : { lt: 0 },
        },
        select: { currentBalance: true, party: { select: { displayName: true } } },
        orderBy: { currentBalance: owedToUs ? 'desc' : 'asc' },
      });

      const total = balances.reduce((sum, row) => sum.plus(D(row.currentBalance)), D(0)).abs();
      const largest = balances[0];

      return {
        ...base,
        answer: balances.length
          ? owedToUs
            ? `${rupees(total)} is owed to you, across ${balances.length} ${balances.length === 1 ? 'account' : 'accounts'}.`
            : `You owe ${rupees(total)}, across ${balances.length} ${balances.length === 1 ? 'account' : 'accounts'}.`
          : owedToUs
            ? 'Nothing is outstanding — every account is settled.'
            : 'You owe nothing.',
        details: largest
          ? [
              {
                label: 'Largest',
                value: `${largest.party.displayName} — ${rupees(D(largest.currentBalance).abs())}`,
              },
            ]
          : [],
      };
    }

    case 'PARTY_LAST_INVOICE': {
      if (!intent.partyId || unsure) {
        return {
          ...base,
          answer: 'Which account was that? Pick the one you meant.',
          choices: needsParty(),
        };
      }

      const invoice = await prisma.salesInvoice.findFirst({
        where: { businessId, partyId: intent.partyId, status: 'ISSUED' },
        orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
        select: {
          invoiceNumber: true,
          invoiceDate: true,
          grandTotal: true,
          amountPaid: true,
          partyName: true,
          items: { select: { productName: true, quantity: true, unitName: true }, take: 5 },
        },
      });

      if (!invoice) {
        return { ...base, answer: 'There are no bills on that account yet.' };
      }

      const due = D(invoice.grandTotal).minus(D(invoice.amountPaid));
      return {
        ...base,
        answer:
          `The last bill to ${invoice.partyName} was ${invoice.invoiceNumber ?? 'unnumbered'} on ` +
          `${formatDate(invoice.invoiceDate)} for ${rupees(invoice.grandTotal)}` +
          (due.greaterThan(0) ? `, of which ${rupees(due)} is still unpaid.` : ', paid in full.'),
        details: invoice.items.map((item) => ({
          label: item.productName,
          value: `${formatQuantity(item.quantity)} ${item.unitName}`,
        })),
      };
    }

    case 'UNKNOWN':
    default:
      return {
        ...base,
        answer:
          'That was not understood. Questions work — a balance, what is in stock, ' +
          'a rate, or the day’s sales. Making a bill or taking a payment has to be done on screen.',
      };
  }
}

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

export interface AskInput {
  /// A recording, when a microphone was used.
  audio?: AudioClip;
  /// Typed words, which is also the fallback when no speech key is configured.
  text?: string;
  /**
   * The answer to "which one did you mean?".
   *
   * When the operator has picked from the offered choices, the question is
   * asked again with their pick attached — and their pick simply overrules
   * whatever the model would have chosen. It is still only an id; every query
   * below is scoped to the business, so an id from elsewhere finds nothing.
   */
  pinnedPartyId?: string;
  pinnedProductId?: string;
}

export async function askVoiceQuestion(
  businessId: string,
  input: AskInput,
  options: AnswerOptions = {},
): Promise<VoiceAnswer> {
  if (!extractor.available) {
    throw badRequestCoded(
      'AI_UNAVAILABLE',
      'Questions are switched off because no AI key is configured on this deployment.',
    );
  }

  let heard: string;
  let engine: string | null = null;

  if (input.audio) {
    const result = await transcriber.transcribe(input.audio);
    if (!result.ok) {
      logger.error({ reason: result.reason }, 'Transcription failed');
      throw badRequestCoded(
        result.unavailable ? 'ASR_UNAVAILABLE' : 'ASR_FAILED',
        result.unavailable
          ? 'Speaking is switched off on this deployment because no speech key is configured. Type the question instead.'
          : 'That recording could not be made out. Say it again, or type it.',
      );
    }
    heard = result.transcript;
    engine = result.engine;
  } else if (input.text?.trim()) {
    heard = input.text.trim();
    engine = 'typed';
  } else {
    throw badRequestCoded('NO_QUESTION', 'Nothing was said or typed.');
  }

  /**
   * Spoken numerals become digits before anything else looks at the sentence.
   *
   * This is deterministic and tested, and it happens ahead of the model so the
   * model never has to work out that "sarhe teen sau" is 350. It matters less
   * for questions than it will for billing, but the pipeline is the same one,
   * and the parser earns its place by being right every time.
   */
  const understood = digitizeNumbers(heard);

  const list = await shortlistFor(businessId, understood);
  const interpreted = await interpret(understood, list);

  // A person pointing at the right row beats the matcher and the model both,
  // and having chosen, they should not be asked again.
  const pinned = input.pinnedPartyId ?? input.pinnedProductId;
  const intent: Intent = pinned
    ? {
        ...interpreted,
        partyId: input.pinnedPartyId ?? interpreted.partyId,
        productId: input.pinnedProductId ?? interpreted.productId,
        confidence: 1,
      }
    : interpreted;

  logger.info(
    { intent: intent.intent, confidence: intent.confidence, engine },
    'Voice question interpreted',
  );

  const answer = await answerIntent(businessId, intent, list, options);
  return { ...answer, heard, understood, engine };
}
