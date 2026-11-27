import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { AppLayout } from '../components/AppLayout';
import { ProtectedRoute } from '../components/auth/ProtectedRoute';
import { HomePage } from '../pages/HomePage';
import { InterviewPage } from '../pages/InterviewPage';
import { DashboardPage } from '../pages/DashboardPage';
import { PricingPage } from '../pages/PricingPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { LoginPage } from '../pages/LoginPage';
import { RegisterPage } from '../pages/RegisterPage';
import { VerifyEmailPage } from '../pages/VerifyEmailPage';
import { ForgotPasswordPage } from '../pages/ForgotPasswordPage';
import { ResetPasswordPage } from '../pages/ResetPasswordPage';

/**
 * Isolated dev-only route for the Voice Conversation Laboratory (P5-VOI-01a).
 * In production builds (import.meta.env.DEV is statically false), Rollup dead-code
 * elimination removes this ternary branch and avoids bundling VoiceLabPage or
 * ONNX/Kokoro runtime assets.
 */
const devRoutes: RouteObject[] =
  import.meta.env.DEV && import.meta.env.MODE === 'development'
    ? [
        {
          path: 'dev/voice-lab',
          lazy: async () => {
            const { VoiceLabPage } = await import('../pages/dev/VoiceLabPage');
            return { Component: VoiceLabPage };
          },
        },
      ]
    : [];

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: 'interview',
        element: (
          <ProtectedRoute routeLabel="Interview Session">
            <InterviewPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'dashboard',
        element: (
          <ProtectedRoute routeLabel="Candidate Dashboard">
            <DashboardPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'pricing',
        element: <PricingPage />,
      },
      {
        path: 'login',
        element: <LoginPage />,
      },
      {
        path: 'register',
        element: <RegisterPage />,
      },
      {
        path: 'verify-email',
        element: <VerifyEmailPage />,
      },
      {
        path: 'forgot-password',
        element: <ForgotPasswordPage />,
      },
      {
        path: 'reset-password',
        element: <ResetPasswordPage />,
      },
      ...devRoutes,
      {
        path: '*',
        element: <NotFoundPage />,
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
