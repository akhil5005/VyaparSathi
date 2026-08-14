import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_MANAGE_USERS } from '../../middleware/authorize.js';
import * as c from './backup.controller.js';

export const backupRouter = Router();

backupRouter.use(authenticate);

/**
 * Owner only.
 *
 * One request returns every customer, every rate, every bill and every rupee
 * of the ledger in a single file. That is the owner's to take and nobody
 * else's — an accountant does not need it, and a departing employee certainly
 * does not.
 */
const canBackUp = authorize(...CAN_MANAGE_USERS);

backupRouter.get('/summary', canBackUp, c.summary);
backupRouter.get('/download', canBackUp, c.download);
