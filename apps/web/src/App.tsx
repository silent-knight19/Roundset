import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './app/AuthContext';
import { router as defaultRouter } from './app/router';
import type { SessionCoordinator } from './lib/auth/sessionCoordinator';

export interface AppProps {
  router?: typeof defaultRouter;
  authCoordinator?: SessionCoordinator;
  skipAuthBootstrap?: boolean;
}

export function App({
  router = defaultRouter,
  authCoordinator,
  skipAuthBootstrap = false,
}: AppProps) {
  return (
    <AuthProvider
      coordinator={authCoordinator}
      skipInitialBootstrap={skipAuthBootstrap}
    >
      <RouterProvider router={router} />
    </AuthProvider>
  );
}

export default App;
