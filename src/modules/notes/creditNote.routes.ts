import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_EDIT_MASTERS, CAN_VIEW } from '../../middleware/authorize.js';
import * as c from './creditNote.controller.js';

export const noteRouter = Router();

noteRouter.use(authenticate);

const canView = authorize(...CAN_VIEW);
// A note moves money back out of the books and reverses tax already reported,
// so it sits with the owner/manager rather than counter staff.
const canIssue = authorize(...CAN_EDIT_MASTERS);

noteRouter.get('/creditable/:invoiceId', canView, c.creditableLines);

noteRouter.get('/', canView, c.list);
noteRouter.post('/preview', canIssue, c.preview);
noteRouter.post('/', canIssue, c.create);
noteRouter.get('/:noteId', canView, c.getOne);
noteRouter.post('/:noteId/cancel', canIssue, c.cancel);
