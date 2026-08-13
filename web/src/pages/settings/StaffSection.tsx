import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDate } from '../../lib/money';
import type { User, UserRole } from '../../lib/types';
import { useAuth } from '../../auth/AuthProvider';
import { roleLabel } from '../../auth/RequireAuth';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Alert, ErrorAlert } from '../../components/Alert';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';

/**
 * Who can sign in, and what they may do.
 *
 * Owner-only, enforced on the server. The roles are not decoration: billing
 * staff genuinely cannot see cost prices or purchase bills, which is the point
 * of giving a counter assistant their own login instead of sharing the owner's.
 */

const ROLES: { id: UserRole; summary: string }[] = [
  { id: 'MANAGER', summary: 'Everything except managing staff' },
  { id: 'BILLING_STAFF', summary: 'Bills and takes payment. No cost prices, no purchases.' },
  { id: 'ACCOUNTANT', summary: 'Sees everything including cost. Cannot bill.' },
  { id: 'VIEWER', summary: 'Read-only' },
];

export function StaffSection() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [settingPasswordFor, setSettingPasswordFor] = useState<User | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: User[] }>('/api/auth/users'),
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/api/auth/users/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const rows = users.data?.users ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Give each person their own login. Roles decide what they can see.
        </p>
        <Button onClick={() => setAdding(true)}>Add person</Button>
      </div>

      <ErrorAlert error={setActive.error} />

      {users.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5 text-slate-400" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Signs in with</th>
                <th className="px-3 py-2.5 font-medium">Role</th>
                <th className="px-3 py-2.5 font-medium">Last seen</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((person) => {
                const isMe = person.id === me?.id;
                return (
                  <tr key={person.id} className={person.isActive ? '' : 'opacity-50'}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {person.fullName}
                        {isMe ? <span className="ml-2 text-xs text-slate-400">you</span> : null}
                      </p>
                      {!person.isActive ? (
                        <p className="text-xs text-rose-600 dark:text-rose-400">Disabled</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-slate-600 dark:text-slate-400">
                      {person.phone}
                      {person.email ? (
                        <span className="block text-xs text-slate-400">{person.email}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-slate-600 dark:text-slate-400">
                      {roleLabel(person.role)}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">
                      {person.lastLoginAt ? formatDate(person.lastLoginAt) : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* Disabling your own account would lock you out of the
                          only screen that could re-enable it. */}
                      {isMe || person.role === 'OWNER' ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setSettingPasswordFor(person)}
                          >
                            Set password
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={setActive.isPending && setActive.variables?.id === person.id}
                            onClick={() =>
                              setActive.mutate({ id: person.id, isActive: !person.isActive })
                            }
                          >
                            {person.isActive ? 'Disable' : 'Enable'}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Alert tone="info">
        Disabling someone signs them out immediately, everywhere — it does not wait for their
        session to expire. Their past invoices and entries stay exactly as they are.
      </Alert>

      {adding ? <AddStaffDialog onClose={() => setAdding(false)} /> : null}

      {settingPasswordFor ? (
        <SetPasswordDialog
          person={settingPasswordFor}
          onClose={() => setSettingPasswordFor(null)}
        />
      ) : null}
    </div>
  );
}

function AddStaffDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('BILLING_STAFF');

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/auth/users', {
        fullName: fullName.trim(),
        phone: phone.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        password,
        role,
      }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const ready = fullName.trim().length >= 2 && phone.trim() && password.length >= 10 && !create.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) create.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add person"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={create.isPending} disabled={!ready}>
            Create login
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={create.error} />

        <Field
          label="Name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={fieldErrors['fullName']}
          required
          autoFocus
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={fieldErrors['phone']}
            hint="They sign in with this"
            inputMode="tel"
            required
            placeholder="9876543210"
          />
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldErrors['email']}
            hint="Optional — also works to sign in"
          />
        </div>

        <Field
          label="Starting password"
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors['password']}
          // Shown, not masked: the owner has to read it out to the person.
          // They can change it themselves once signed in.
          hint={
            password.length > 0 && password.length < 10
              ? `${10 - password.length} more characters needed`
              : 'At least 10 characters. Tell it to them — they can change it after signing in.'
          }
          required
        />

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
            What they can do
          </legend>
          <div className="space-y-2">
            {ROLES.map(({ id, summary }) => (
              <label
                key={id}
                className={[
                  'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition',
                  role === id
                    ? 'border-slate-900 bg-slate-50 dark:border-slate-100 dark:bg-slate-800'
                    : 'border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/50',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="role"
                  checked={role === id}
                  onChange={() => setRole(id)}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                    {roleLabel(id)}
                  </span>
                  <span className="block text-xs text-slate-500">{summary}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/**
 * The owner setting a staff member's password.
 *
 * This is the working answer to "I forgot my password" in an Indian shop. SMS
 * to a mobile needs DLT registration under the TRAI mandate, most counter staff
 * have no email address, and the owner is standing next to them anyway.
 *
 * The password is shown rather than masked, because the owner has to read it
 * out. Setting it signs that person out everywhere immediately — usually the
 * point, since the reason for resetting is often that someone else knows the
 * old one.
 */
function SetPasswordDialog({ person, onClose }: { person: User; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);

  const set = useMutation({
    mutationFn: () =>
      api.post(`/api/auth/users/${person.id}/set-password`, { newPassword: password }),
    onSuccess: () => setDone(true),
  });

  const fieldErrors = set.error instanceof ApiError ? set.error.fieldErrors : {};
  const ready = password.length >= 10 && !set.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (ready) set.mutate();
  }

  if (done) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Password set"
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <div className="space-y-4">
          <Alert tone="success">
            {person.fullName} can now sign in with this password. They have been signed out
            everywhere else.
          </Alert>
          <div className="rounded-lg bg-slate-50 px-3 py-3 text-center dark:bg-slate-800/60">
            <p className="text-xs text-slate-500">Tell them this — it is not shown again</p>
            <p className="mt-1 font-mono text-lg font-semibold text-slate-900 dark:text-slate-100">
              {password}
            </p>
          </div>
          <p className="text-xs text-slate-500">
            They can change it themselves from their own account after signing in.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Set password for ${person.fullName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={set.isPending} disabled={!ready}>
            Set password
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorAlert error={set.error} />

        <Alert tone="warning">
          This signs {person.fullName} out of every device straight away, and cancels any reset
          link already sent to them.
        </Alert>

        <Field
          label="New password"
          // Shown, not masked: the owner has to read it out loud.
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors['newPassword']}
          hint={
            password.length > 0 && password.length < 10
              ? `${10 - password.length} more characters needed`
              : 'At least 10 characters. A short phrase they will remember beats symbols.'
          }
          required
          autoFocus
          placeholder="counter wala paper"
        />

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
