import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';
import { signInModule } from './modules/signIn';
import { toolsModule } from './modules/tools';
import { themeModule } from './modules/theme';
import { spaceModule } from './modules/space';

export default createApp({
  features: [catalogPlugin, navModule, homeModule, signInModule, toolsModule, spaceModule, themeModule],
});
