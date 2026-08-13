import { z } from 'zod';

export const gstr1QuerySchema = z.object({
  /// Return period, "YYYY-MM". GSTR-1 is monthly; a quarterly filer under QRMP
  /// still uploads month by month.
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Period must look like 2026-07'),
});
