/**
 * What each page shows, as data rather than as markup.
 *
 * Keeping the card list declarative is what lets the fetch layer ask the server
 * for exactly the metrics the current page needs, instead of every metric the
 * dashboard knows about. Adding a card to a page is a one-line change here.
 */

/**
 * How a card draws its data. Two of these are not plots:
 *
 *   `table` — a ledger with seven signed columns has no shape worth seeing, and
 *     the reader's question, "what did each column contribute?", is answered by
 *     the figures.
 *   `share` — a composition read at one instant: rows are the parts, not the
 *     buckets, each with its value and its share of the whole.
 *   `retention` — one curve per plan of the share still installed each day
 *     after installing, with the per-plan band table behind the toggle; drawn
 *     from the response's `meta`, because its x-axis is days, not dates.
 */
export type PlotKind = 'line' | 'bar' | 'area' | 'table' | 'share' | 'retention';

export interface CardSpec {
  /** Key into the overview response, and the metric the server computes. */
  metric: string;
  label: string;
  subtitle?: string;
  /**
   * What the "i" beside the label says, where the card frames its metric
   * differently from everywhere else. Otherwise `METRIC_INFO` answers.
   */
  info?: string;
  plot: PlotKind;
  /** Draw the metric's component breakdown instead of its total. */
  breakdown?: boolean;
  /**
   * Append a row totalling each column over the whole window, and colour the
   * signs. Only flows total meaningfully — summing a level across twelve months
   * produces a number that means nothing.
   */
  ledger?: { totalLabel: string; emphasize?: string };
  /**
   * What a `share` card calls its rows, the line that totals them, and — where
   * "Value" would not say it — the measure being divided.
   */
  share?: { partLabel: string; totalLabel: string; valueLabel?: string };
  /**
   * What the plot is measuring, when that is not neutral. Growth draws green and
   * churn draws red, per the design system; everything else draws in the brand.
   * Ignored on breakdown cards, where the categorical slots identify the series.
   */
  tone?: 'growth' | 'churn';
  /** Metrics where a rise is bad, so the delta colours invert. */
  invertDelta?: boolean;
  /**
   * Draw every part of a breakdown, not only the first four. Uses the extended
   * colour slots, so it is for cards whose parts are many and named in a legend
   * — a plan mix — rather than for a fixed set of components.
   */
  allSeries?: boolean;
  /**
   * What the big figure is. By default a level shows where it ended and a flow
   * its total. `change` shows how far a level moved across the range instead,
   * with where it started and ended beneath — for a count that ends today on
   * every preset, the level alone reads the same whatever range is picked.
   */
  headline?: 'change';
  /** Let one card take the whole row; still at most three cards across. */
  full?: boolean;
  /** Forecasts describe the current pipeline rather than a prior period. */
  comparisonNote?: string;
}

export interface PageSpec {
  id: string;
  label: string;
  title: string;
  /**
   * One line under the title, where the page is a report and the line says
   * what is being measured. Working pages — a queue, a ledger, a list with its
   * own figures at the top — leave it off: the tiles say more in less space,
   * and a sentence between the title and them is a sentence in the way.
   */
  blurb?: string;
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
  kind?:
    | 'metrics'
    | 'customers'
    | 'notifications'
    | 'reviews'
    | 'listings'
    | 'plan-intervals'
    | 'funnel'
    | 'bigquery'
    | 'organizations'
    // The affiliate program: five views over one set of source tables, none of
    // which is a metric over the shared time window.
    | 'affiliate-programs'
    | 'affiliates'
    | 'referrals'
    | 'claims'
    | 'payouts';
  /**
   * Which shared filters this page shows, in order.
   *
   * Declared rather than assumed because they are not universally meaningful:
   * which components make up MRR changes nothing on a page about App Store
   * reviews, and a rating filter changes nothing anywhere else.
   */
  filters?: PageFilter[];
  /**
   * What the shared filters should read when this page is opened.
   *
   * The window is shared across reports so that moving between them keeps the
   * question fixed, but "shared" is not the same as "right everywhere": a year
   * of daily funnel columns is a matrix nobody reads left to right. A page that
   * declares defaults gets them applied on entry, and the reader can still
   * change them afterwards.
   */
  defaults?: Partial<PageDefaults>;
}

export interface PageDefaults {
  period: string;
  granularity: 'day' | 'week' | 'month' | 'previous_7_days';
}

export type PageFilter =
  | 'org'
  | 'app'
  | 'range'
  | 'rating'
  | 'granularity';

/**
 * What a metric page shows when it has not asked for anything different.
 *
 * The organization comes first because it is the widest of them: it decides
 * which apps the app picker beside it can even offer. It renders as nothing at
 * all on an instance with one organization, which is every instance that has
 * never used this feature.
 *
 * `components` stands where `trials` used to: the trials toggle became one of
 * the three MRR components, and the control that replaced it carries all three.
 */
export const DEFAULT_FILTERS: PageFilter[] = ['org', 'app', 'range'];

export interface NavGroup {
  label: string;
  pages: PageSpec[];
}

/*
 * The vocabulary every card below keeps to, so one idea has one name:
 *
 *   store            a shop with the app installed, paying or not
 *   paying customer  a store paying something — a plan price, a plan fee
 *                    billed as usage, or metered usage. Counted once per app.
 *   MRR              what paying customers pay per month, right now
 *   earnings         what was paid in a period after Shopify's share — the
 *                    figure Shopify's own dashboard calls Earnings
 *
 * Every card answers one plain question, and no two cards answer the same one
 * on the same page.
 */

const MRR_CARD: CardSpec = {
  metric: 'mrr',
  label: 'MRR',
  subtitle: 'What paying customers pay per month, right now.',
  plot: 'line',
};

const EARNINGS_CARD: CardSpec = {
  metric: 'earnings',
  label: 'Earnings',
  subtitle: 'Paid to you in the range, after Shopify’s share. Same as Shopify’s Earnings.',
  plot: 'bar',
};

const PAYING_CUSTOMERS: CardSpec = {
  metric: 'subscribers',
  label: 'Paying customers',
  subtitle: 'Stores paying you something, right now.',
  plot: 'line',
};

const MERCHANT_GROWTH: CardSpec = {
  metric: 'active_installs',
  label: 'Merchant growth',
  subtitle: 'Change in stores with the app installed. Same as Shopify’s Merchant growth.',
  plot: 'line',
  headline: 'change',
  tone: 'growth',
};

const PLAN_SIGNUPS: CardSpec = {
  metric: 'plan_signups',
  label: 'Plan signups',
  subtitle: 'Stores that picked a plan in the range.',
  plot: 'bar',
  breakdown: true,
  allSeries: true,
};

const ON_TRIAL: CardSpec = {
  metric: 'on_trial',
  label: 'On trial',
  subtitle: 'Stores in their free trial on a paid plan.',
  plot: 'line',
};

const NEW_PAYING: CardSpec = {
  metric: 'new_subscriptions',
  label: 'New paying customers',
  subtitle: 'Stores that made their first payment in the range.',
  plot: 'bar',
  tone: 'growth',
};

const REVENUE_CHURN: CardSpec = {
  metric: 'revenue_churn',
  label: 'Revenue churn',
  subtitle: 'Share of MRR lost to cancellations over 30 days.',
  plot: 'line',
  tone: 'churn',
  invertDelta: true,
};

const OVERVIEW: PageSpec = {
  id: 'overview',
  label: 'Overview',
  title: 'Overview',
  blurb: 'How the business is doing, at a glance.',
  cards: [MRR_CARD, EARNINGS_CARD, PAYING_CUSTOMERS, MERCHANT_GROWTH, PLAN_SIGNUPS, ON_TRIAL],
};

const REVENUE: PageSpec = {
  id: 'revenue',
  label: 'Revenue',
  title: 'Revenue',
  blurb: 'How much you earn, where it comes from, and why it changed.',
  cards: [
    {
      ...MRR_CARD,
      subtitle: 'What paying customers pay per month, split by plan prices, plan fees billed as usage, and metered usage.',
      plot: 'area',
      breakdown: true,
    },
    EARNINGS_CARD,
    {
      metric: 'arpu',
      label: 'Revenue per customer',
      subtitle: 'MRR divided by paying customers.',
      plot: 'line',
    },
    {
      metric: 'mrr_movement',
      label: 'Why MRR changed',
      subtitle:
        'Each store’s change in MRR, by reason. Losses are negative; each row adds up to Net, the change in MRR over that period.',
      plot: 'table',
      breakdown: true,
      full: true,
      ledger: { totalLabel: 'Whole range', emphasize: 'net' },
      comparisonNote: 'Change in MRR over the range',
    },
    {
      metric: 'mrr_by_plan',
      label: 'MRR by plan',
      subtitle: 'Which plans the MRR comes from, right now. Adds up to MRR.',
      plot: 'share',
      breakdown: true,
      full: true,
      share: { partLabel: 'Plan', totalLabel: 'All plans' },
    },
    {
      metric: 'money_by_plan',
      label: 'Earnings by plan',
      subtitle: 'What each plan’s stores paid in the range, after Shopify’s share. Adds up to Earnings.',
      plot: 'bar',
      breakdown: true,
      full: true,
      allSeries: true,
    },
    {
      metric: 'mrr_by_app',
      label: 'MRR by app',
      subtitle: 'Which app the MRR comes from, right now. Adds up to MRR.',
      plot: 'share',
      breakdown: true,
      full: true,
      share: { partLabel: 'App', totalLabel: 'All apps' },
    },
  ],
};

const SUBSCRIPTIONS: PageSpec = {
  id: 'subscriptions',
  label: 'Growth',
  title: 'Growth',
  blurb: 'From install to paying customer: who arrives, who tries a plan, and who starts paying.',
  cards: [
    MERCHANT_GROWTH,
    PLAN_SIGNUPS,
    ON_TRIAL,
    {
      metric: 'trial_conversion_rate',
      label: 'Trial conversion',
      subtitle: 'Of trials started in the range that have ended, the share that paid.',
      plot: 'line',
    },
    NEW_PAYING,
    PAYING_CUSTOMERS,
    {
      metric: 'subscriptions_by_plan',
      label: 'Paying customers by plan',
      subtitle: 'Which plans paying customers are on, right now.',
      plot: 'share',
      breakdown: true,
      full: true,
      share: { partLabel: 'Plan', totalLabel: 'All plans', valueLabel: 'Customers' },
    },
    {
      metric: 'new_subscriptions_by_plan',
      label: 'New paying customers by plan',
      subtitle: 'Which plans the stores that made their first payment were on.',
      plot: 'bar',
      breakdown: true,
      full: true,
      allSeries: true,
    },
  ],
};

const CHURN: PageSpec = {
  id: 'churn',
  label: 'Churn',
  title: 'Churn',
  blurb: 'Who leaves, measured over the 30 days before each point. Lower is better.',
  cards: [
    REVENUE_CHURN,
    {
      metric: 'subscription_churn',
      label: 'Customer churn',
      subtitle: 'Share of paying customers who cancelled over 30 days.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'logo_churn',
      label: 'Uninstall rate',
      subtitle: 'Uninstalls minus reinstalls over 30 days, as a share of installed stores.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
  ],
};

const RETENTION: PageSpec = {
  id: 'retention',
  label: 'Retention',
  title: 'Retention',
  blurb: 'Stores that installed in the range: which plan they picked, and how long they stayed.',
  filters: ['org', 'app', 'range'],
  cards: [
    {
      metric: 'installs_by_plan',
      label: 'New installs',
      subtitle: 'Stores that installed in the range, by the plan they then picked.',
      plot: 'bar',
      breakdown: true,
      full: true,
      allSeries: true,
    },
    {
      metric: 'uninstalls_by_plan',
      label: 'Still installed',
      subtitle:
        'Of the stores that installed in the range, the share still installed 1, 15 and 90 days later, by plan. Greyed rates rest on fewer than 10 installs.',
      plot: 'retention',
      full: true,
      allSeries: true,
      comparisonNote: 'Installs made in the range',
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
  filters: ['org', 'app', 'range', 'rating'],
};

const FUNNEL: PageSpec = {
  id: 'funnel',
  label: 'Funnel',
  title: 'Funnel',
  blurb:
    'From the listing page to a paying merchant, and where along the way they stop.',
  kind: 'funnel',
  cards: [],
  // No trials toggle: this page is *about* trials as a step, not about whether
  // they count towards revenue. Granularity takes the slot, because the whole
  // report is a matrix and the column width is the reader's main lever.
  filters: ['org', 'app', 'granularity', 'range'],
  // A day-by-day read of the last month: narrow enough that the columns still
  // fit an eye-sweep, long enough that a trial started at the start of it has
  // had time to decide. The twelve months every other report opens on would be
  // 365 columns of five steps.
  defaults: { granularity: 'day', period: 'last_30_days' },
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

const PLAN_INTERVALS: PageSpec = {
  id: 'plan-intervals',
  label: 'Plan intervals',
  title: 'Plan intervals',
  blurb: 'Tell MRR which plans bill yearly.',
  kind: 'plan-intervals',
  cards: [],
};

const ORGANIZATIONS: PageSpec = {
  id: 'organizations',
  label: 'Organizations',
  title: 'Organizations',
  kind: 'organizations',
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

const BIGQUERY: PageSpec = {
  id: 'bigquery',
  label: 'BigQuery',
  title: 'BigQuery',
  blurb:
    'The GA4 export behind the funnel.',
  kind: 'bigquery',
  cards: [],
};

/* ------------------------------------------------------------ affiliates
 *
 * A group of its own rather than entries under Reports: these are not reports
 * over the shared time window but a working area — two approval queues, a
 * ledger and two lists — and the shared filters mean nothing in it.
 *
 * None of the five carries a blurb. Each opens on its own figures, and the
 * title already repeats the nav entry that was just clicked; a third statement
 * of the same noun, set as a sentence, only pushed the tiles down the page.
 */

const AFFILIATE_PROGRAMS: PageSpec = {
  id: 'affiliate-programs',
  label: 'Programs',
  title: 'Programs',
  kind: 'affiliate-programs',
  cards: [],
};

const AFFILIATES: PageSpec = {
  id: 'affiliates',
  label: 'Affiliates',
  title: 'Affiliates',
  kind: 'affiliates',
  cards: [],
};

const REFERRALS: PageSpec = {
  id: 'referrals',
  label: 'Referrals',
  title: 'Referrals',
  kind: 'referrals',
  cards: [],
};

/** Directly after Referrals, because a claim is the thing that becomes one. */
const CLAIMS: PageSpec = {
  id: 'claims',
  label: 'Claims',
  title: 'Claims',
  kind: 'claims',
  cards: [],
};

const PAYOUTS: PageSpec = {
  id: 'payouts',
  label: 'Payouts',
  title: 'Payouts',
  kind: 'payouts',
  cards: [],
};

/**
 * What each metric is and how it is counted, for the "i" beside a card's label.
 *
 * The subtitle says what the card shows; this says what the number means, in
 * words for someone who does not read SaaS metrics for a living. Keyed by
 * metric rather than written per card, because the same metric sits on several
 * pages and should be explained the same way on each.
 */
const METRIC_INFO: Record<string, string> = {
  mrr: 'Monthly recurring revenue: what your paying customers pay per month at each point. Plan prices (yearly plans at a twelfth), plus plan fees and metered usage billed as usage charges — metered usage as a smoothed monthly rate. Free trials do not count until they pay. A store’s MRR stops the moment it cancels, freezes or uninstalls.',
  earnings: 'What merchants paid in the range after Shopify’s revenue share, with refunds and credits taken off — the same figure as Earnings on Shopify’s dashboard. The line beneath is the amount billed before Shopify’s share.',
  subscribers: 'Stores paying you something right now, counted once per app: a priced plan, or a $0 plan whose fee or usage is being billed. Free plans, trials, and plans not billed yet are not counted.',
  active_installs: 'How many more (or fewer) stores have the app installed at the end of the range than at its start: installs minus uninstalls. The same figure as Merchant growth on Shopify’s dashboard.',
  plan_signups: 'Stores that picked a plan in the range, split by what they chose: a paid plan with a free trial, a paid plan without one, or the free plan. Counted the day they pick it, whether or not they ever pay. Switching plans does not count.',
  on_trial: 'Stores in the free trial of a paid plan at each point. The line beneath is what MRR would gain each month if every one of today’s trials started paying.',
  new_subscriptions: 'Stores that made their first payment in the range. On a plan billed through usage this can be days or weeks after they picked it, so it is not the same as Plan signups. Switching plans does not count.',
  trial_conversion_rate: 'Of the free trials that started in the range and have ended, the share that went on to pay. Trials still running are left out until they end.',
  subscriptions_by_plan: 'The plans your paying customers are on right now.',
  new_subscriptions_by_plan: 'The plans the stores that made their first payment in the range were on.',
  arpu: 'MRR divided by paying customers: what an average paying store pays per month.',
  mrr_movement: 'Why MRR changed, store by store. New: paying for the first time. Reactivated: paying again after leaving. Plan upgrades and downgrades: a store that stayed and now pays a different plan price. Usage expansion and contraction: a store that stayed and was billed more or less metered usage. Frozen and unfrozen: Shopify paused or resumed the store. Churned: everything a store paid, when it cancelled or uninstalled.',
  mrr_by_plan: 'How today’s MRR divides across your plans, plan fees and usage included.',
  money_by_plan: 'What the stores on each plan paid in the range, after Shopify’s share. Adds up to Earnings.',
  mrr_by_app: 'How today’s MRR divides across your apps.',
  revenue_churn: 'Of the MRR your customers paid 30 days before each point, the share lost to stores that cancelled or uninstalled since. Plan switches are not churn. Lower is better.',
  subscription_churn: 'Of the stores paying 30 days before each point, the share that has cancelled or uninstalled since. Plan switches are not churn. Lower is better.',
  logo_churn: 'Uninstalls minus reinstalls over the 30 days before each point, as a share of all installed stores at its start — free stores included. Lower is better.',
  installs_by_plan: 'Stores that installed in the range, by the first plan they picked. “No plan” is stores that installed but never picked one.',
  uninstalls_by_plan: 'Of the stores that installed in the range, the share still installed today and 1, 15 and 90 days after installing, by the plan they picked.',
  reviews_live: 'How many reviews are visible on your App Store listing at each point, after removals.',
  reviews_average_rating: 'The average star rating of the reviews visible on your listing at each point.',
  reviews_removed: 'Reviews that disappeared from your listing in each period — deleted by the merchant or removed by Shopify.',
  reviews_posted: 'New reviews posted to your listing in each period, split by star rating.',
};

/** The explanation for a card's "i", or nothing if there is none to give. */
export function infoFor(card: CardSpec): string | undefined {
  return card.info ?? METRIC_INFO[card.metric];
}

export const NAV: NavGroup[] = [
  { label: '', pages: [OVERVIEW, CUSTOMERS] },
  { label: 'Reports', pages: [REVENUE, SUBSCRIPTIONS, CHURN, RETENTION, FUNNEL, REVIEWS] },
  { label: 'Affiliates', pages: [AFFILIATE_PROGRAMS, AFFILIATES, REFERRALS, CLAIMS, PAYOUTS] },
  { label: 'Settings', pages: [ORGANIZATIONS, LISTINGS, PLAN_INTERVALS, BIGQUERY, NOTIFICATIONS] },
];

export const PAGES: PageSpec[] = NAV.flatMap((group) => group.pages);

export function pageById(id: string): PageSpec {
  return PAGES.find((page) => page.id === id) ?? OVERVIEW;
}

/** The metric keys one page needs, deduplicated. */
export function metricsFor(page: PageSpec): string[] {
  return [...new Set(page.cards.map((card) => card.metric))];
}
