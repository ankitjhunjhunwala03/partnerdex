/**
 * How a cancel is paired with the activation that replaces it (spec §4.a/§4.b).
 *
 * Shopify performs a plan change as one operation: it cancels the old recurring
 * charge and activates the new one milliseconds apart, which is why the fold in
 * `events.ts` tie-breaks them at a shared instant. The pairing window exists to
 * absorb that gap and nothing else.
 *
 * It used to be `PLAN_CHANGE_WINDOW_DAYS`, two days wide and measured with
 * `Math.abs`, and that is far too generous to mean "the same operation". Any
 * merchant who cancelled and signed up again inside a long weekend was paired
 * with themselves: their cancellation was written off as a tier move, so a real
 * loss and a real win-back both vanished from the numbers, and the fold read
 * their return as an upgrade. The spec is specific about the sizes, and about
 * the direction — an activation *before* a cancel cannot be replacing it.
 */
export const PLAN_CHANGE_WINDOW_SECONDS = 60;
