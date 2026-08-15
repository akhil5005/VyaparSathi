# AI stack — Punjabi voice billing

The chosen stack, why each piece was chosen over the alternative, and the rules
the implementation has to follow.

---

## The shape of the pipeline

```
  mic (push-to-talk)
      │
      ▼
  ① ASR                Sarvam Saarika (pa-IN)  ─fallback→  OpenAI Whisper
      │  raw transcript: "Sharma Stationery de bill vich das ream A4 paper do sau chali rate te"
      ▼
  ② Number normalizer  src/modules/voice/punjabiNumbers.ts   ← deterministic, no model
      │  "Sharma Stationery de bill vich 10 ream A4 paper 240 rate te"
      ▼
  ③ Candidate lookup   Postgres pg_trgm + phonetic index     ← deterministic, no model
      │  customers: [Sharma Stationery 0.91, Sharma Stationers 0.88]
      │  products:  [JK Copier A4 75gsm 0.86]
      ▼
  ④ Intent extraction  Claude (claude-opus-5) + structured outputs
      │  { intent: "ADD_LINE_ITEM", partyId, productId, quantity, unit, rate, confidence }
      ▼
  ⑤ Confirmation UI    always. the model never writes to the database.
      │
      ▼
  ⑥ Commit             the same service layer the manual form calls
```

**Everything that can be deterministic, is.** Steps ② and ③ exist specifically to
shrink what the model is asked to do. By the time Claude sees the utterance, the
numbers are already digits and the candidate parties and products are already a
shortlist — so the only job left is picking from a list and assigning fields,
which is the thing models are reliable at.

---

## Component choices

| Stage | Chosen | Over | Why |
|---|---|---|---|
| **ASR** | **Sarvam AI (Saarika)** | Whisper, Web Speech API | Trained specifically on Indian languages including Punjabi, and handles the Punjabi–Hindi–English code-switching a shopkeeper actually speaks. Web Speech API's `pa-IN` support is poor and browser-dependent — it is not a serious option here. Keep Whisper wired as a fallback for when Sarvam is down or the utterance is mostly English. |
| **Number parsing** | **Custom parser** (`punjabiNumbers.ts`) | Letting the LLM do it | `sarhe teen` (3.5), `sava do sau` (225), `paune char` (3.75) are a closed grammar. A parser is right every time and unit-tested; a model is right most of the time and wrong silently. These are quantities and rates — the two fields where being wrong means a wrong bill. **36 tests currently green.** |
| **Entity matching** | **Postgres `pg_trgm` + phonetic key**, then Claude to disambiguate | Pure vector search, or pure LLM | Trigram similarity on a few hundred customer names is sub-millisecond and needs no embedding pipeline. The model only breaks ties between the top candidates — it is never asked to invent a party. |
| **Intent extraction** | **Claude `claude-opus-5`** with structured outputs | Gemini, GPT | Best instruction-following on the transliterated Punjabi + strict-schema combination, and structured outputs guarantee the response parses. Model IDs and API shapes are pinned in code — see the snippet below. |
| **Read-back / TTS** | **Sarvam Bulbul** (pa-IN) | Browser speechSynthesis | Confirming "das ream, do sau chali rate, kul chaubi sau" aloud is faster than reading a screen with dusty hands, and browser TTS has no usable Punjabi voice. |
| **Embeddings** | **pgvector**, only if needed | Always-on vector search | Deferred. Trigram matching handles a catalog this size. Add pgvector when the product list outgrows it, not before. |

---

## Rules the implementation must follow

**1. Voice never writes to the database.**
Step ④ produces a *proposal*. Step ⑤ renders it as an editable confirmation card
the shopkeeper taps to accept. The commit in step ⑥ goes through the exact same
service functions the manual form uses — same validation, same tax computation,
same audit log. There is no voice-specific write path to get out of sync.

**2. Read-only voice ships first.**
"Sharma nu kinna paisa dena hai?" → answer. No write risk, immediately useful,
and it lets you measure real-world ASR accuracy on the shopkeeper's actual speech
before anything can create a bad invoice. Build billing-by-voice only once the
query path is reliably understanding them.

**3. Low confidence surfaces choices, it does not guess.**
Below the confidence threshold, or when two candidate parties are within a few
points of each other, show both and let the operator pick. A wrong customer on a bill is
a much worse outcome than one extra tap.

**4. Every voice-created invoice is flagged.**
`SalesInvoice.createdViaVoice` and `voiceSessionId` exist so you can measure
what fraction of voice bills get edited before confirmation. That number is your
accuracy metric — without it you are guessing about whether the feature works.

**5. Store the audio and the transcript for failures.**
When the operator corrects a proposal, keep the clip. That corpus is what lets you fix the
parser and tune the prompt against real speech instead of imagined speech.

---

## The Claude call

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const BillCommand = z.object({
  intent: z.enum(['ADD_LINE_ITEM', 'SET_CUSTOMER', 'REMOVE_LINE', 'FINALISE', 'QUERY_BALANCE', 'UNKNOWN']),
  partyId: z.string().nullable(),
  productId: z.string().nullable(),
  quantity: z.number().nullable(),
  unitSymbol: z.string().nullable(),
  rate: z.number().nullable(),
  /// 0-1. Below ~0.8 the UI must show alternatives rather than a single answer.
  confidence: z.number().min(0).max(1),
  /// Why the model chose these ids — shown to the user on the confirmation card.
  reasoning: z.string(),
});

const response = await client.messages.parse({
  model: 'claude-opus-5',
  // Thinking is ON by default on Opus 5 and counts against max_tokens.
  // Leave headroom or the JSON truncates mid-object.
  max_tokens: 8000,
  output_config: {
    // Low effort, thinking left on. Do NOT set thinking:{type:"disabled"} here —
    // on Opus 5 that can make the model emit a tool call as plain text and leak
    // <thinking> tags into the output. Lowering effort is the correct cost lever.
    effort: 'low',
    format: zodOutputFormat(BillCommand),
  },
  system: [
    {
      type: 'text',
      text: BILLING_AGENT_INSTRUCTIONS,
      // Stable prefix — cached so every utterance in a session is cheap.
      // Opus 5's minimum cacheable prefix is 512 tokens.
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      // Only the shortlist from step ③, not the whole catalog.
      text: `Candidate customers:\n${candidateParties}\n\nCandidate products:\n${candidateProducts}`,
    },
  ],
  messages: [{ role: 'user', content: digitizedUtterance }],
});

// Opus 5 can decline a request outright — a 200 with no usable content.
// Check this before touching .parsed_output.
if (response.stop_reason === 'refusal') {
  return { intent: 'UNKNOWN', confidence: 0 };
}

const command = response.parsed_output;
```

Notes on the call, each of which is load-bearing:

- **`output_config.format`** guarantees the response validates against the
  schema, so there is no JSON-repair code path to maintain.
- **`cache_control` on the instruction block** — the system prompt is identical
  across every utterance in a billing session, so it is written to cache once
  and read at ~10% cost thereafter. Keep the volatile candidate list *after* the
  cached block; caching is a prefix match and any change above a breakpoint
  invalidates everything below it.
- **`effort: 'low'`** is the latency and cost lever. Claude Opus 5 performs
  unusually well at low effort, and this task is deliberately shaped to be easy.
- **`stop_reason === 'refusal'`** must be checked before reading content —
  reading `.parsed_output` unconditionally will throw on the day it fires.

---

## Environment variables

Already stubbed in `.env.example`:

```
ANTHROPIC_API_KEY=
ASR_PROVIDER=sarvam        # or "openai"
SARVAM_API_KEY=
OPENAI_API_KEY=            # Whisper fallback only
```

---

## Build order

1. `punjabiNumbers.ts` — **done**, 36 tests green.
2. Candidate lookup over `Party.displayName` and `Product.name` +
   `Product.aliasNames` — **done**, `src/modules/ai/match.ts`, 15 tests.
3. Read-only voice queries ("kinna paisa dena hai") end to end — **done**,
   `src/modules/voice/`, 29 tests.
4. Billing-by-voice with the confirmation card.
5. TTS read-back once voice is in daily use.

---

## What was actually built, where it differs from the plan above

Three deliberate departures, each of which has held up in the code:

**Candidate lookup is in TypeScript, not `pg_trgm`.** `src/modules/ai/match.ts`
is Sørensen–Dice over bigrams plus token containment. On a few hundred names it
is a fraction of a millisecond, it needs no Postgres extension enabled on a
managed database, and — the reason that decided it — it is a pure function, so
the matching rules are tested directly rather than through a query. Revisit if
the catalogue reaches thousands of rows.

**Structured output comes from a forced tool call, not `output_config`.**
`src/lib/anthropic.ts` posts to `/v1/messages` with plain `fetch`, defines one
tool carrying the caller's JSON Schema and sets
`tool_choice: { type: 'tool', name: 'record' }`. Same guarantee that the reply
parses, no SDK dependency, and it matches how `notifier.ts` already talks to
Resend. Prompt caching is not used yet — a question is a single call, so there
is no repeated prefix to cache.

**Reading a photographed supplier bill was built first**, ahead of voice. It
shares the whole matching layer, it is the slowest job in the shop, and it is
always done with the source document in hand — which makes it the safest place
to find out how the extraction behaves on real paper.

Two rules were added to the list above while building the query path, and both
are enforced rather than intended:

- **The model never states a figure.** It picks an intent and an id; every
  amount, quantity and date in the answer is composed by
  `voiceQuery.service.ts` from the database. A model that phrases the number
  can get the number wrong, and a confidently wrong balance read out at a
  counter is worse than no feature at all.
- **Ids are validated against the shortlist.** `validateIntent` drops anything
  the model returns that was not on the list it was given, so a hallucinated
  cuid can never reach a `where` clause. `voiceQuery.test.ts` tests that
  directly, and `voiceQuery.itest.ts` runs every intent and asserts that no
  row, balance, stock figure or number sequence moved.
