/**
 * The two GA4 events the funnel is built on, and not a setting.
 *
 * `page_view` when a merchant opens the App Store listing, `Add App button`
 * when they click Install. Note the lowercase 'button': GA4 event names are
 * case-sensitive and this one is spelled exactly as Shopify's Universal
 * Analytics instrumentation left it, so `Add App Button` matches nothing at
 * all — silently, as an empty step, indistinguishable from a listing nobody
 * visited.
 *
 * These were once configurable and the freedom bought nothing. There is one
 * publisher of these events and one spelling that works; a field offering to
 * change them only offered a way to break the report.
 *
 * Deliberately a module of its own with no imports. The schema migration has to
 * compare against these to know whether a database was collected under the old,
 * configurable names, and importing the connection module from the database
 * layer would close a cycle.
 */
export const LISTING_VIEW_EVENT = 'page_view';
export const ADD_APP_CLICK_EVENT = 'Add App button';
