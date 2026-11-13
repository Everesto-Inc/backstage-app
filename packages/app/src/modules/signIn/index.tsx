import {
  createFrontendModule,
  githubAuthApiRef,
} from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { SignInPage } from '@backstage/core-components';

// GitHub login. Who may sign in is decided by the backend (app-config.production.yaml):
// only GitHub users that exist as a User entity in the catalog.
const githubProvider = {
  id: 'github-auth-provider',
  title: 'GitHub',
  message: 'Sign in with your GitHub account',
  apiRef: githubAuthApiRef,
};

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props => (
      <SignInPage
        {...props}
        // "guest" only for local development (yarn start); never in the production build
        providers={
          process.env.NODE_ENV === 'production'
            ? [githubProvider]
            : ['guest', githubProvider]
        }
      />
    ),
  },
});

export const signInModule = createFrontendModule({
  pluginId: 'app',
  extensions: [signInPage],
});
