import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuthProvider,
  CAN_BILL,
  CAN_EDIT_MASTERS,
  CAN_FILE_RETURNS,
  CAN_RECEIVE_PAYMENT,
} from './auth/AuthProvider';
import { RequireAuth, RequireRole } from './auth/RequireAuth';
import { LoginPage } from './auth/LoginPage';
import { SignupPage } from './auth/SignupPage';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage';
import { ResetPasswordPage } from './auth/ResetPasswordPage';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { BillingPage } from './pages/billing/BillingPage';
import { PaymentsPage } from './pages/payments/PaymentsPage';
import { ProductsPage } from './pages/products/ProductsPage';
import { PurchasesPage } from './pages/purchases/PurchasesPage';
import { InvoicesPage } from './pages/invoices/InvoicesPage';
import { PartiesPage } from './pages/parties/PartiesPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { NotesPage } from './pages/notes/NotesPage';
import { Gstr1Page } from './pages/returns/Gstr1Page';
import { AccountPage } from './pages/account/AccountPage';
import { ApiError } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Stock and balances move whenever anyone bills, so this data is stale
      // almost immediately — but refetching on every window focus at a busy
      // counter is worse than a few seconds of staleness.
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry(failureCount, error) {
        // Never retry a 4xx: a 403 or a validation failure will fail again the
        // same way, and retrying a 401 fights with the token refresh.
        if (error instanceof ApiError && !error.isTransient) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      // A mutation is a real document being written. Retrying one automatically
      // risks issuing the same invoice twice.
      retry: false,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Signed out */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />

            {/* Signed in */}
            <Route element={<RequireAuth />}>
              <Route element={<Layout />}>
                <Route index element={<DashboardPage />} />
                <Route element={<RequireRole allow={CAN_BILL} />}>
                  <Route path="billing" element={<BillingPage />} />
                </Route>
                <Route path="invoices" element={<InvoicesPage />} />
                <Route path="parties" element={<PartiesPage />} />
                <Route path="products" element={<ProductsPage />} />
                {/* Every role, deliberately: Settings is manager-and-above, so
                    putting the password form there would leave a billing clerk
                    with no way to change their own. */}
                <Route path="account" element={<AccountPage />} />

                <Route element={<RequireRole allow={CAN_RECEIVE_PAYMENT} />}>
                  <Route path="payments" element={<PaymentsPage />} />
                </Route>

                <Route element={<RequireRole allow={CAN_FILE_RETURNS} />}>
                  <Route path="gstr1" element={<Gstr1Page />} />
                </Route>

                <Route element={<RequireRole allow={CAN_EDIT_MASTERS} />}>
                  <Route path="credit-notes" element={<NotesPage />} />
                  <Route path="purchases" element={<PurchasesPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
