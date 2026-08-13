import { useAuth } from '../../auth/AuthProvider';
import { Alert } from '../../components/Alert';

/**
 * The shop's own details.
 *
 * Read-only, deliberately. These are snapshotted onto every invoice at issue
 * time, and the GSTIN in particular decides CGST+SGST versus IGST on every bill
 * ever raised — changing it in a settings form would be a way to quietly
 * invalidate a year of documents. A firm that genuinely re-registers needs a
 * migration, not a text box.
 */
export function BusinessSection() {
  const { business, user } = useAuth();

  if (!business) return null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {business.tradeName || business.legalName}
        </h2>
        {business.tradeName && business.tradeName !== business.legalName ? (
          <p className="text-sm text-slate-500">{business.legalName}</p>
        ) : null}

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Row term="GSTIN" value={business.gstin} mono />
          <Row term="State" value={`${business.stateName} (${business.stateCode})`} />
          <Row term="City" value={business.city} />
          <Row term="Phone" value={business.phone} />
          <Row term="Signed in as" value={`${user?.fullName} · ${user?.role.toLowerCase()}`} />
        </dl>
      </div>

      <Alert tone="info">
        These are printed on every invoice and are fixed once the firm is
        registered. The GSTIN decides CGST+SGST versus IGST on every bill, so changing it is a
        migration rather than an edit — ask before you need to.
      </Alert>
    </div>
  );
}

function Row({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{term}</dt>
      <dd
        className={`mt-0.5 text-slate-900 dark:text-slate-100 ${mono ? 'font-mono text-sm' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
