import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_FILE_RETURNS } from '../../middleware/authorize.js';
import * as c from './gstr1.controller.js';

export const gstr1Router = Router();

gstr1Router.use(authenticate);

/**
 * Returns are an owner, manager and accountant matter. A counter clerk has no
 * business exporting the month's entire sales register, GSTIN by GSTIN.
 */
const canFile = authorize(...CAN_FILE_RETURNS);

gstr1Router.get('/summary', canFile, c.summary);
gstr1Router.get('/download', canFile, c.download);
