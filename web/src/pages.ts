/**
 * What each page shows, as data rather than as markup.
 *
 * Keeping the card list declarative is what lets the fetch layer ask the server
 * for exactly the metrics the current page needs, instead of every metric the
 * dashboard knows about. Adding a card to a page is a one-line change here.
 */

export type PlotKind = 'line' | 'bar' | 'area';

export interface CardSpec {
  /** Key into the overview response, and the metric the server computes. */
  metric: string;
  label: string;
  subtitle?: string;
  plot: PlotKind;
  /** Draw the metric's component breakdown instead of its total. */
  breakdown?: boolean;
  /**
   * What the plot is measuring, when that is not neutral. Growth draws green and
   * churn draws red, per the design system; everything else draws in the brand.
   * Ignored on breakdown cards, where the categorical slots identify the series.
   */
  tone?: 'growth' | 'churn';
  /** Metrics where a rise is bad, so the delta colours invert. */
  invertDelta?: boolean;
  /** Let one card take the whole row; still at most three cards across. */
  full?: boolean;
}

export interface PageSpec {
  id: string;
  label: string;
  title: string;
  blurb: string;
  cards: CardSpec[];
  /**
   * Metric pages are a grid of cards over a shared time window. Customers and
   * notifications are different shapes entirely — a searchable population, and
   * a settings form — so they opt out of the window controls rather than
   * showing filters that would not apply to them.
   *
   * Reviews is the one page that is both: cards over the shared window, and a
   * searchable list of the documents behind them.
   */
  kind?: 'metrics' | 'customers' | 'notifications' | 'reviews' | 'listings';
  /**
   * Which shared filters this page shows, in order.
   *
   * Declared rather than assumed because they are not universally meaningful:
   * which components make up MRR changes nothing on a page about App Store
   * reviews, and a rating filter changes nothing anywhere else.
   */
  filters?: PageFilter[];
}

export type PageFilter = 'app' | 'range' | 'components' | 'rating';

/** What a metric page shows when it has not asked for anything different. */
export const DEFAULT_FILTERS: PageFilter[] = ['app', 'range', 'components'];

export interface NavGroup {
  label: string;
  pages: PageSpec[];
}

const OVERVIEW: PageSpec = {
  id: 'overview',
  label: 'Overview',
  title: 'Overview',
  blurb: 'The five figures that say whether the business is working.',
  cards: [
    {
      metric: 'mrr',
      label: 'MRR',
      subtitle: 'Recurring revenue live at each point.',
      plot: 'line',
    },
    {
      metric: 'gross_earnings',
      label: 'Gross earnings',
      subtitle: 'Billed in the period, before revenue share.',
      plot: 'bar',
    },
    {
      metric: 'revenue_churn',
      label: 'Revenue churn',
      subtitle: 'MRR lost against the MRR at the window start.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'subscribers',
      label: 'Subscribers',
      subtitle: 'Shop-and-app pairs currently paying.',
      plot: 'line',
    },
    {
      metric: 'on_trial',
      label: 'On trial',
      subtitle: 'Inside the free period at each point.',
      plot: 'line',
    },
  ],
};

const REVENUE: PageSpec = {
  id: 'revenue',
  label: 'Revenue',
  title: 'Revenue',
  blurb: 'What is being earned, how fast it is growing, and what each customer is worth.',
  cards: [
    { metric: 'mrr', label: 'MRR', subtitle: 'Recurring revenue live at each point.', plot: 'line' },
    { metric: 'arr', label: 'ARR', subtitle: 'Run-rate: MRR × 12.', plot: 'line' },
    {
      metric: 'gross_earnings',
      label: 'Gross earnings',
      subtitle: 'Billed in the period, before revenue share.',
      plot: 'bar',
    },
    {
      metric: 'mrr_growth',
      label: 'MRR growth',
      subtitle: 'Change against the bucket before.',
      plot: 'line',
      tone: 'growth',
    },
    {
      metric: 'arpu',
      label: 'ARPU',
      subtitle: 'MRR over the paying population.',
      plot: 'line',
    },
    {
      metric: 'ltv',
      label: 'LTV',
      subtitle: 'ARPU over monthly churn. Directional, not a cohort measure.',
      plot: 'line',
    },
    {
      metric: 'mrr_by_app',
      label: 'MRR contribution by app',
      subtitle: 'Where the recurring revenue comes from.',
      plot: 'area',
      breakdown: true,
      full: true,
    },
  ],
};

const SUBSCRIPTIONS: PageSpec = {
  id: 'subscriptions',
  label: 'Subscriptions',
  title: 'Subscriptions',
  blurb: 'Who is paying, who just started, and who is still deciding.',
  cards: [
    {
      metric: 'subscribers',
      label: 'Active subscribers',
      subtitle: 'Shop-and-app pairs currently paying.',
      plot: 'line',
    },
    {
      metric: 'new_subscriptions',
      label: 'New subscriptions',
      subtitle: 'Started paying in the period, excluding plan changes.',
      plot: 'bar',
      tone: 'growth',
    },
    {
      metric: 'subscription_growth',
      label: 'Subscription growth',
      subtitle: 'Change against the bucket before.',
      plot: 'line',
      tone: 'growth',
    },
    {
      metric: 'on_trial',
      label: 'On trial',
      subtitle: 'Inside the free period at each point.',
      plot: 'line',
    },
    {
      metric: 'trial_conversion_rate',
      label: 'Trial conversion',
      subtitle: 'Share of decided trials that reached a paid charge.',
      plot: 'line',
    },
  ],
};

const CHURN: PageSpec = {
  id: 'churn',
  label: 'Churn',
  title: 'Churn',
  blurb:
    'The same loss measured three ways. Revenue churn runs above the others when the customers leaving are the expensive ones.',
  cards: [
    {
      metric: 'revenue_churn',
      label: 'Revenue churn',
      subtitle: 'MRR lost against the MRR at the window start.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'subscription_churn',
      label: 'Subscription churn',
      subtitle: 'Contracts lost against those live at the window start.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'logo_churn',
      label: 'Logo churn',
      subtitle: 'Uninstalls net of reinstalls against installs active at the window start.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
  ],
};

const CUSTOMERS: PageSpec = {
  id: 'customers',
  label: 'Customers',
  title: 'Customers',
  blurb: 'Every merchant, what they run today, and everything that has happened to them.',
  kind: 'customers',
  cards: [],
};

const REVIEWS: PageSpec = {
  id: 'reviews',
  label: 'Reviews',
  title: 'Reviews',
  blurb:
    'Everything on your App Store listing, and everything that used to be.',
  kind: 'reviews',
  cards: [
    {
      metric: 'reviews_live',
      label: 'Reviews on the listing',
      subtitle: 'Live at each point, removals taken off.',
      plot: 'line',
    },
    {
      metric: 'reviews_average_rating',
      label: 'Average rating',
      subtitle: 'Mean of the reviews live at each point.',
      plot: 'line',
    },
    {
      metric: 'reviews_removed',
      label: 'Removed',
      subtitle: 'Deleted / purged from the listing.',
      plot: 'bar',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'reviews_posted',
      label: 'New reviews',
      subtitle: 'Posted in the period.',
      plot: 'bar',
      full: true,
    },
  ],
  // Revenue components have nothing to do with a listing. The rating filter
  // takes the slot and reaches every card, so the whole page can be read one
  // star at a time.
  filters: ['app', 'range', 'rating'],
};

const LISTINGS: PageSpec = {
  id: 'listings',
  label: 'App listings',
  title: 'App listings',
  blurb:
    'Which App Store page belongs to which of your apps.',
  kind: 'listings',
  cards: [],
};

const NOTIFICATIONS: PageSpec = {
  id: 'notifications',
  label: 'Notifications',
  title: 'Notifications',
  blurb: 'Send customer events to Slack as they happen, instead of noticing them a week later.',
  kind: 'notifications',
  cards: [],
};

export const NAV: NavGroup[] = [
  { label: '', pages: [OVERVIEW, CUSTOMERS] },
  { label: 'Reports', pages: [REVENUE, SUBSCRIPTIONS, CHURN, REVIEWS] },
  { label: 'Settings', pages: [LISTINGS, NOTIFICATIONS] },
];

export const PAGES: PageSpec[] = NAV.flatMap((group) => group.pages);

export function pageById(id: string): PageSpec {
  return PAGES.find((page) => page.id === id) ?? OVERVIEW;
}

/** The metric keys one page needs, deduplicated. */
export function metricsFor(page: PageSpec): string[] {
  return [...new Set(page.cards.map((card) => card.metric))];
}
