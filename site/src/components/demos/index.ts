import ChatDemo from './ChatDemo.astro';
import BrowserDemo from './BrowserDemo.astro';
import ComputerDemo from './ComputerDemo.astro';
import KanbanDemo from './KanbanDemo.astro';
import GithubDemo from './GithubDemo.astro';
import LamentsDemo from './LamentsDemo.astro';
import AtpDemo from './AtpDemo.astro';
import PhoneDemo from './PhoneDemo.astro';
import VisualsDemo from './VisualsDemo.astro';
import PluginsDemo from './PluginsDemo.astro';

/** The animated mock on each feature page, by feature slug. */
export const DEMOS: Record<string, typeof ChatDemo> = {
  chat: ChatDemo,
  browser: BrowserDemo,
  'computer-use': ComputerDemo,
  kanban: KanbanDemo,
  github: GithubDemo,
  laments: LamentsDemo,
  atp: AtpDemo,
  phone: PhoneDemo,
  visuals: VisualsDemo,
  plugins: PluginsDemo,
};
