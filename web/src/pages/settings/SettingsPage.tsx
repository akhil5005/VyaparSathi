import { useState } from 'react';
import { CAN_MANAGE_USERS, useAuth } from '../../auth/AuthProvider';
import { PrintersSection } from './PrintersSection';
import { HsnSection } from './HsnSection';
import { StaffSection } from './StaffSection';
import { BusinessSection } from './BusinessSection';
import { BackupSection } from './BackupSection';

/**
 * The things you set up once and then rarely touch.
 *
 * Grouped by how often they change rather than by which table they live in:
 * the shop's own details almost never, printers when hardware is replaced, GST
 * rates when the Council revises a slab, staff when someone joins or leaves.
 */

type Tab = 'business' | 'printers' | 'hsn' | 'staff' | 'backup';

export function SettingsPage() {
  const { can } = useAuth();
  const canManageUsers = can(...CAN_MANAGE_USERS);
  const [tab, setTab] = useState<Tab>('business');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'business', label: 'Shop' },
    { id: 'printers', label: 'Printers' },
    { id: 'hsn', label: 'GST rates' },
    // Staff management and backups are owner-only on the server; hiding the
    // tabs avoids offering a manager a screen that would 403 on every action.
    ...(canManageUsers ? ([{ id: 'staff' as const, label: 'Staff' }]) : []),
    ...(canManageUsers ? ([{ id: 'backup' as const, label: 'Backup' }]) : []),
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Settings
        </h1>
        <p className="mt-1 text-sm text-slate-500">Set up once, change rarely.</p>
      </header>

      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={[
              '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition',
              tab === id
                ? 'border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'business' ? <BusinessSection /> : null}
      {tab === 'printers' ? <PrintersSection /> : null}
      {tab === 'hsn' ? <HsnSection /> : null}
      {tab === 'staff' && canManageUsers ? <StaffSection /> : null}
      {tab === 'backup' && canManageUsers ? <BackupSection /> : null}
    </div>
  );
}
