import { RouterProvider } from 'react-router-dom';
import { router as defaultRouter } from './app/router';

export interface AppProps {
  router?: typeof defaultRouter;
}

export function App({ router = defaultRouter }: AppProps) {
  return <RouterProvider router={router} />;
}

export default App;
