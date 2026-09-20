/* The review schedule, in one place.
 *
 * The page uses it to decide what to ask next; engine/ingest.py rebuilds the
 * same state from the saved answers. tools/check_schedule.py runs both against
 * the same events and fails if they disagree, so this file and ingest.py cannot
 * drift apart unnoticed.
 *
 * Rule
 *   boxes 0..N
 *   correct -> next box, due = answered_at + gap(box)
 *   wrong   -> down one box, or two from box 4 up, and due right away so it
 *              comes back in this sitting
 *   a correct answer given before the card was due does not move it up once it
 *   has reached box 2; repeating a card minutes after getting it right is not
 *   evidence that it will still be there tomorrow
 *
 * Why the fall is not all the way down
 *   WaniKani drops a card by one step below its fifth stage and by two above
 *   it, never past the first. Missing a card that was on a three week gap says
 *   the gap had grown too long, not that the card is new. Sending it back to
 *   the start throws away every correct answer before it, which on a deadline
 *   is time there is none of. Since a wrong answer also sets the card due at
 *   once, it still comes back within the same sitting either way.
 *
 * The gap
 *   With a deadline ahead, the gap is a fraction of the time left rather than
 *   a fixed number of minutes: 2%, 6%, 15%, 30% as the card moves up. Thirty
 *   hours before a trip that lays the reviews at roughly 36 minutes, 2 hours,
 *   7 hours and 14 hours from the start, so a card is met four times and one
 *   of those crosses a night's sleep. A fixed ladder would spend 24 of those
 *   30 hours on a single step and fit two reviews in total. The fractions come
 *   from Cepeda et al. (2008), who measured the best gap for recognition at
 *   roughly 24% of the retention interval when that interval is short, and
 *   fall below it deliberately to buy an extra repetition.
 *   With no deadline, or once it has passed, the plain minute ladder applies.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Schedule = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const READY_BOX = 2;
  const BIG_FALL_FROM = 4;   // at this box and above, a miss costs two steps
  const DEFAULT_INTERVALS = [0, 10, 1440, 4320, 10080, 30240];
  const DEFAULT_FRACTIONS = [0, 0.02, 0.06, 0.15, 0.30, 0.30];
  const MIN_GAP_MINUTES = 10;
  const MAX_SHARE_OF_REMAINING = 0.6;

  /** Minutes to wait after landing in `box`. */
  function gapMinutes(box, atMs, intervals, deadlineMs, fractions) {
    const ivs = intervals && intervals.length ? intervals : DEFAULT_INTERVALS;
    const fixed = ivs[Math.min(box, ivs.length - 1)];
    if (!deadlineMs || Number.isNaN(deadlineMs)) return fixed;
    const left = (deadlineMs - atMs) / 60000;
    if (left <= 0) return fixed;
    const fr = fractions && fractions.length ? fractions : DEFAULT_FRACTIONS;
    const share = fr[Math.min(box, fr.length - 1)];
    const wanted = left * share;
    return Math.min(Math.max(wanted, MIN_GAP_MINUTES), left * MAX_SHARE_OF_REMAINING);
  }

  function blank() {
    return { box: 0, due: null, seen: 0, correct: 0, lastCorrect: null, lastTs: 0, history: '' };
  }

  /** Fold one answer into a card's state. tsMs is when it was answered. */
  function apply(st, correct, tsMs, intervals, deadlineMs, fractions) {
    const ivs = intervals && intervals.length ? intervals : DEFAULT_INTERVALS;
    const early = st.due !== null && tsMs < st.due;
    if (correct) {
      if (early && st.box >= READY_BOX) {
        // leave box and due as they are
      } else {
        st.box = Math.min(st.box + 1, ivs.length - 1);
        st.due = tsMs + gapMinutes(st.box, tsMs, ivs, deadlineMs, fractions) * 60000;
      }
    } else {
      st.box = Math.max(0, st.box - (st.box >= BIG_FALL_FROM ? 2 : 1));
      st.due = tsMs;
    }
    st.seen += 1;
    st.correct += correct ? 1 : 0;
    st.lastCorrect = correct;
    st.lastTs = tsMs;
    st.history = (st.history + (correct ? 'o' : 'x')).slice(-10);
    return st;
  }

  /** A card counts as known when it has climbed far enough AND the last answer
   *  was right. Without the second half, a card missed from a high box would
   *  still be counted, because one miss no longer sends it to the bottom. */
  function known(st) {
    return !!st && st.box >= READY_BOX && st.lastCorrect === true;
  }

  /** Replay a whole event list. Returns a plain object keyed by question id. */
  function replay(events, intervals, deadlineMs, fractions) {
    const seen = new Set();
    const list = [];
    for (const ev of events) {
      if (!ev || !ev.id || !ev.qid || seen.has(ev.id)) continue;
      seen.add(ev.id);
      list.push(ev);
    }
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
    const out = {};
    for (const ev of list) {
      if (!out[ev.qid]) out[ev.qid] = blank();
      apply(out[ev.qid], !!ev.correct, Date.parse(ev.ts), intervals, deadlineMs, fractions);
    }
    return out;
  }

  return { READY_BOX, BIG_FALL_FROM, DEFAULT_INTERVALS, DEFAULT_FRACTIONS,
           gapMinutes, blank, apply, known, replay };
});
