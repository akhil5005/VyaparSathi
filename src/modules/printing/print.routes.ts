import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, CAN_BILL, CAN_EDIT_MASTERS, CAN_VIEW } from '../../middleware/authorize.js';
import * as c from './print.controller.js';

export const printRouter = Router();

printRouter.use(authenticate);

const canView = authorize(...CAN_VIEW);
const canPrint = authorize(...CAN_BILL);
/// Printer hardware is a setup task, not a counter task.
const canConfigure = authorize(...CAN_EDIT_MASTERS);

// Documents. Reading an invoice PDF is a view action — an accountant emailing a
// copy to a customer shouldn't need billing rights.
printRouter.get('/invoices/:invoiceId/pdf', canView, c.invoicePdf);
printRouter.get('/invoices/:invoiceId/receipt', canView, c.receipt);
printRouter.post('/invoices/:invoiceId/receipt', canPrint, c.sendReceipt);

// Printer profiles.
printRouter.get('/printers', canView, c.listPrinters);
printRouter.post('/printers', canConfigure, c.createPrinter);
printRouter.patch('/printers/:printerId', canConfigure, c.updatePrinter);
printRouter.delete('/printers/:printerId', canConfigure, c.deletePrinter);
printRouter.post('/printers/:printerId/test', canConfigure, c.testPrinter);
