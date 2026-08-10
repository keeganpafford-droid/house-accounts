// Foundation freeze, Phase 1C/1D: targeted regression for the calendar-day
// semantics correction and the impossible-calendar-date rejection.
//
// Phase 1C root cause (confirmed via scripts/test-temporal-integrity-fixtures.js,
// previously misdiagnosed as flakiness): production mixed calendar-date
// values (a date with no time-of-day, e.g. "2026-06-23") with wall-clock
// instants (`new Date()`, which always carries the real current time-of-day)
// when computing day counts -- `Math.round((instant - calendarDate) / 86400000)`
// can round to a different integer depending purely on what time of day the
// comparison happens to run, even though the two dates are always the same
// number of CALENDAR days apart. calendarDaysBetween() (api/signal-intelligence.js)
// and its mirrored client copy calendarDaysAgo() (dashboard/index.html) fix
// this by normalizing BOTH sides to UTC midnight before differencing.
//
// Phase 1D: parseCalendarDateUTC() must REJECT an impossible calendar date
// (Sep 31, Apr 31, Feb 29 in a non-leap year) rather than silently rolling
// it over to the next valid date via native Date.UTC() overflow semantics
// (e.g. Date.UTC(2026, 8, 31) silently becomes October 1). An invalid date
// mention must produce no exact date, not a stable-but-wrong fingerprint.
//
// Usage: node scripts/test-foundation-freeze-calendar-day-semantics.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';
import { calendarDaysBetween, extractEventDate } from '../api/signal-intelligence.js';
import { computeActionability } from '../api/research-batch.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Client-mirror extraction: calendarDaysAgo()/formatSignalAge() cannot be
// imported (dashboard/index.html is a plain browser-loaded inline script),
// so extract the real, verbatim source into a vm sandbox, exactly like the
// established pattern in scripts/test-avidia-date-fixed-clock-regression.js.
// ===========================================================================
const DASHBOARD_SRC = loadDashboardSource();


const PARSE_MAYBE_DATE_SRC = extractFn(DASHBOARD_SRC, 'parseMaybeDate');
const CALENDAR_DAYS_AGO_SRC = extractFn(DASHBOARD_SRC, 'calendarDaysAgo');

function makeClientSandbox(fixedNow){
  const sandbox = { console, Date, Math };
  vm.createContext(sandbox);
  new vm.Script(`${PARSE_MAYBE_DATE_SRC}\n\n${CALENDAR_DAYS_AGO_SRC}`, { filename: 'calendar-days-ago-extract.js' }).runInContext(sandbox);
  return sandbox;
}

// ===========================================================================
// Required test set 1 -- calendarDaysBetween() (backend, real import)
// ===========================================================================
{
  // Same calendar day, different times of day -- must be 0 regardless of
  // how far apart the two wall-clock times are within that single day.
  const earlyMorning = new Date('2026-08-06T00:05:00Z');
  const lateNight = new Date('2026-08-06T23:55:00Z');
  assert(calendarDaysBetween(lateNight, earlyMorning) === 0, 'calendarDaysBetween(): two instants on the SAME calendar day are 0 days apart, even 23h50m apart in wall-clock time');

  // Yesterday, right across the midnight boundary -- must be exactly 1 even
  // though less than an hour of real wall-clock time separates them. This is
  // the exact defect class Math.round(msDiff / 86400000) got wrong: 55
  // minutes is a small fraction of a day, so a plain ms-based round would
  // have returned 0, not 1.
  const justBeforeMidnight = new Date('2026-08-05T23:55:00Z');
  const justAfterMidnight = new Date('2026-08-06T00:50:00Z');
  assert(calendarDaysBetween(justAfterMidnight, justBeforeMidnight) === 1, 'calendarDaysBetween(): a calendar date just before midnight and a comparison instant just after midnight are 1 calendar day apart, not 0, even though only 55 minutes of wall-clock time separate them');

  // The inverse: two instants nearly 24h apart but on the SAME calendar day
  // must still read as 0 days, proving this is genuinely calendar-day math,
  // not a disguised "less than N hours" heuristic.
  const almostFullDayApartA = new Date('2026-08-06T00:01:00Z');
  const almostFullDayApartB = new Date('2026-08-06T23:59:00Z');
  assert(calendarDaysBetween(almostFullDayApartB, almostFullDayApartA) === 0, 'calendarDaysBetween(): nearly 24h apart but the SAME calendar day is still 0 days, not 1');

  // Month/year boundary correctness.
  assert(calendarDaysBetween(new Date('2026-01-01T00:00:00Z'), new Date('2025-12-31T23:59:00Z')) === 1, 'calendarDaysBetween(): crosses a year boundary correctly (Dec 31 -> Jan 1 is 1 day)');
  assert(calendarDaysBetween(new Date('2026-03-01T00:00:00Z'), new Date('2026-02-28T00:00:00Z')) === 1, 'calendarDaysBetween(): Feb 28 -> Mar 1 in a non-leap year is 1 day');
  assert(calendarDaysBetween(new Date('2028-03-01T00:00:00Z'), new Date('2028-02-28T00:00:00Z')) === 2, 'calendarDaysBetween(): Feb 28 -> Mar 1 in a LEAP year is 2 days (Feb 29 exists)');

  // Fixed test clock -- deterministic 43-day-old event, matching the same
  // fixture shape as the existing Avidia fixed-clock regression, proving
  // this shared primitive produces the exact expected count.
  const fixedNow = new Date('2026-08-05T18:30:00Z');
  const eventDate = new Date('2026-06-23T00:00:00Z');
  assert(calendarDaysBetween(fixedNow, eventDate) === 43, `calendarDaysBetween(): a fixed test clock 43 real calendar days after the event date returns exactly 43 (got ${calendarDaysBetween(fixedNow, eventDate)})`);

  // Timezone independence -- calendarDaysBetween() operates purely on a
  // Date object's UTC components (getUTCFullYear/getUTCMonth/getUTCDate),
  // so the process's local TZ must have zero effect on the result.
  const originalTZ = process.env.TZ;
  const tzResults = [];
  for(const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Kolkata']){
    process.env.TZ = tz;
    tzResults.push({ tz, days: calendarDaysBetween(new Date('2026-08-05T12:00:00Z'), new Date('2026-06-23T00:00:00Z')) });
  }
  process.env.TZ = originalTZ;
  assert(tzResults.every(r => r.days === 43), `calendarDaysBetween(): identical result across every tested timezone including America/New_York (got ${JSON.stringify(tzResults)})`);
}

// ===========================================================================
// Required test set 2 -- calendarDaysAgo() (client mirror) parity with the
// backend primitive, proving both sides of the "two implementations, one
// contract" boundary agree.
// ===========================================================================
{
  const sandbox = makeClientSandbox();
  const fixedNow = new Date('2026-08-06T00:50:00Z');

  assert(sandbox.calendarDaysAgo('2026-08-06', fixedNow) === 0, 'calendarDaysAgo(): a signal dated today (same calendar day as "now") is 0 days ago, matching the backend primitive');
  assert(sandbox.calendarDaysAgo('2026-08-05', fixedNow) === 1, 'calendarDaysAgo(): a signal dated yesterday is 1 day ago even when "now" is only 50 minutes past midnight');

  // Different times of day for "now" must never change the result for a
  // fixed calendar-date input.
  const sameCalendarDayNows = ['2026-08-06T00:01:00Z', '2026-08-06T12:00:00Z', '2026-08-06T23:59:00Z'];
  const results = sameCalendarDayNows.map(iso => sandbox.calendarDaysAgo('2026-08-01', new Date(iso)));
  assert(results.every(r => r === 5), `calendarDaysAgo(): a fixed signal date returns the identical day count regardless of what time of day "now" is (got ${JSON.stringify(results)})`);

  // Timezone independence for the client mirror too.
  const originalTZ = process.env.TZ;
  const tzResults = [];
  for(const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Kolkata']){
    process.env.TZ = tz;
    tzResults.push({ tz, days: sandbox.calendarDaysAgo('2026-06-23', new Date('2026-08-05T12:00:00Z')) });
  }
  process.env.TZ = originalTZ;
  assert(tzResults.every(r => r.days === 43), `calendarDaysAgo(): identical result across every tested timezone including America/New_York (got ${JSON.stringify(tzResults)})`);
}

// ===========================================================================
// Required test set 3 -- computeActionability() boundaries (api/research-batch.js),
// confirmed via direct inspection to share formatSignalAge()'s exact defect
// and fixed via the same calendarDaysBetween() primitive.
// ===========================================================================
{
  // Event-like: the FOLLOW_UP_WINDOW_DAYS boundary is 45 days. An event
  // exactly 45 days in the past must still read "recent-past"; one day
  // further must read "stale" -- and this boundary must not flip depending
  // on what time of day the fixed "now" carries, proving it is calendar-day
  // based, not wall-clock-instant based.
  const now = new Date('2026-08-05T23:40:00Z');
  const exactly45DaysAgo = new Date('2026-06-21T00:00:00Z'); // 45 calendar days before Aug 5
  const status45 = computeActionability({ eventCategory: 'event-like', eventDate: exactly45DaysAgo.toISOString().slice(0, 10), dateConfidence: 'exact', now });
  assert(status45.status === 'recent-past', `computeActionability(): an event exactly 45 days in the past (the FOLLOW_UP_WINDOW_DAYS boundary) is still "recent-past" (got "${status45.status}")`);

  const exactly46DaysAgo = new Date('2026-06-20T00:00:00Z');
  const status46 = computeActionability({ eventCategory: 'event-like', eventDate: exactly46DaysAgo.toISOString().slice(0, 10), dateConfidence: 'exact', now });
  assert(status46.status === 'stale', `computeActionability(): an event 46 days in the past (one past the FOLLOW_UP_WINDOW_DAYS boundary) is "stale" (got "${status46.status}")`);

  // The exact same boundary, evaluated with a "now" at a different time of
  // day (early morning instead of late night) on the SAME calendar day,
  // must produce the identical classification -- this is the direct proof
  // that the fix closes the "flips depending on time of day" defect.
  const sameCalendarDayEarlyNow = new Date('2026-08-05T00:05:00Z');
  const status45EarlyNow = computeActionability({ eventCategory: 'event-like', eventDate: exactly45DaysAgo.toISOString().slice(0, 10), dateConfidence: 'exact', now: sameCalendarDayEarlyNow });
  assert(status45EarlyNow.status === status45.status, `computeActionability(): the 45-day boundary classification is identical regardless of what time of day "now" is on the same calendar day (late night: "${status45.status}", early morning: "${status45EarlyNow.status}")`);

  // Ongoing: the ONGOING_RECENCY_CEILING_DAYS boundary is 180 days.
  const exactly180DaysAgo = new Date(now.getTime() - 180 * 86400000);
  exactly180DaysAgo.setUTCHours(0, 0, 0, 0);
  const ongoing180 = computeActionability({ eventCategory: 'ongoing', publicationDate: exactly180DaysAgo.toISOString().slice(0, 10), now });
  assert(ongoing180.status === 'ongoing', `computeActionability(): an ongoing business change published exactly 180 days ago (the ONGOING_RECENCY_CEILING_DAYS boundary) is still "ongoing" (got "${ongoing180.status}")`);

  const exactly181DaysAgo = new Date(now.getTime() - 181 * 86400000);
  exactly181DaysAgo.setUTCHours(0, 0, 0, 0);
  const ongoing181 = computeActionability({ eventCategory: 'ongoing', publicationDate: exactly181DaysAgo.toISOString().slice(0, 10), now });
  assert(ongoing181.status === 'ongoing-stale', `computeActionability(): an ongoing business change published 181 days ago (one past the ceiling) is "ongoing-stale" (got "${ongoing181.status}")`);
}

// ===========================================================================
// Required test set 4 (Phase 1D) -- parseCalendarDateUTC() rejects
// impossible calendar dates instead of silently rolling them over, exercised
// through the real exported extractEventDate() (the production text-to-date
// path every fresh signal's event date is resolved through).
// ===========================================================================
{
  const sep31 = extractEventDate('The ribbon cutting is scheduled for September 31, 2026 at the new location.');
  assert(sep31.eventDate === null && sep31.dateConfidence === 'unknown', `extractEventDate(): "September 31" (September has only 30 days) is rejected outright -- no exact date, never silently rolled to October 1 (got ${JSON.stringify(sep31)})`);

  const apr31 = extractEventDate('Join us for the grand opening on April 31, 2026.');
  assert(apr31.eventDate === null && apr31.dateConfidence === 'unknown', `extractEventDate(): "April 31" (April has only 30 days) is rejected outright -- no exact date, never silently rolled to May 1 (got ${JSON.stringify(apr31)})`);

  const feb29NonLeap = extractEventDate('The community festival takes place on February 29, 2026.');
  assert(feb29NonLeap.eventDate === null && feb29NonLeap.dateConfidence === 'unknown', `extractEventDate(): "February 29, 2026" (2026 is not a leap year) is rejected outright -- no exact date, never silently rolled to March 1 (got ${JSON.stringify(feb29NonLeap)})`);

  const feb29Leap = extractEventDate('The community festival takes place on February 29, 2028.');
  assert(feb29Leap.eventDate === '2028-02-29' && feb29Leap.dateConfidence === 'exact', `extractEventDate(): "February 29, 2028" (2028 IS a leap year) is accepted with the exact date (got ${JSON.stringify(feb29Leap)})`);

  // A genuinely valid date in the same shape is unaffected by the hardening.
  const valid = extractEventDate('The ribbon cutting is scheduled for September 18, 2026 at the new location.');
  assert(valid.eventDate === '2026-09-18' && valid.dateConfidence === 'exact', `extractEventDate(): a genuinely valid calendar date is unaffected by the impossible-date hardening (got ${JSON.stringify(valid)})`);
}

if(failures > 0){
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
