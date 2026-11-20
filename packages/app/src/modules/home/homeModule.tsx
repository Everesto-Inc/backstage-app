import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { HomePageLayoutBlueprint, HomePageWidgetBlueprint, HomePageLayoutProps } from '@backstage/plugin-home-react/alpha';

/**
 * everesto.live home page (/):
 *   greeting · My DevOps Spaces (roles + scorecard summary) · Pull requests (to review / mine) · Announcements ·
 *   Platform tools · Recently visited · Starred.  Widgets live in ./widgets (lazy-loaded); this file only wires them.
 */
const widget = (name: string, title: string, description: string, load: () => Promise<{ Content: () => JSX.Element }>) =>
  HomePageWidgetBlueprint.make({ name, params: { name, title, description, components: load } });

const myWidgets = [
  widget('everesto-spaces', 'My DevOps Spaces', 'Your spaces, your role and how their applications score',
    () => import('./widgets').then(m => ({ Content: m.MySpaces }))),
  widget('everesto-prs', 'Pull requests', 'Waiting for your review, and your own open pull requests',
    () => import('./widgets').then(m => ({ Content: m.PullRequests }))),
  widget('everesto-tools', 'Platform tools', 'The tools behind the portal',
    () => import('./widgets').then(m => ({ Content: m.PlatformTools }))),
];

/** Fixed two-column layout: our widgets first, then the built-in Recently visited / Starred; other widgets are not shown. */
const layout = HomePageLayoutBlueprint.make({
  name: 'everesto',
  params: {
    loader: async () => {
      const { HomeLayout } = await import('./widgets');
      return (props: HomePageLayoutProps) => <HomeLayout {...props} />;
    },
  },
});

export const homeModule = createFrontendModule({
  pluginId: 'home',
  extensions: [...myWidgets, layout],
});
