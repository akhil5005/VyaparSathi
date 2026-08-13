import { contextOf, handler, scopeOf } from '../../lib/http.js';
import * as service from './creditNote.service.js';
import {
  cancelNoteSchema,
  createNoteSchema,
  listNotesQuerySchema,
  previewNoteSchema,
} from './creditNote.schemas.js';

export const preview = handler(async (req, res) => {
  const input = previewNoteSchema.parse(req.body);
  res.json(await service.previewNote(scopeOf(req).businessId, input));
});

export const create = handler(async (req, res) => {
  const input = createNoteSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.status(201).json(await service.createNote(businessId, userId, input, contextOf(req)));
});

export const list = handler(async (req, res) => {
  const filter = listNotesQuerySchema.parse(req.query);
  res.json(await service.listNotes(scopeOf(req).businessId, filter));
});

export const getOne = handler(async (req, res) => {
  res.json({ note: await service.getNote(scopeOf(req).businessId, req.params.noteId!) });
});

export const cancel = handler(async (req, res) => {
  const { reason } = cancelNoteSchema.parse(req.body);
  const { businessId, userId } = scopeOf(req);
  res.json(await service.cancelNote(businessId, userId, req.params.noteId!, reason, contextOf(req)));
});

/// What is still available to credit on an invoice — the UI caps its quantity
/// box with this rather than letting a double return fail on submit.
export const creditableLines = handler(async (req, res) => {
  res.json(await service.getCreditableLines(scopeOf(req).businessId, req.params.invoiceId!));
});
