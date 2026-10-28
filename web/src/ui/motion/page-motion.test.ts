import { describe, expect, it } from 'vitest';

import { EDGE, guessBrowserSwipe, isIOS, navMotion, ownsEdgeSwipe, scrolledSideways, settleSwipe, swipeMove, swipeStart, underPose, UNDER_OPACITY } from './page-motion';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

describe('navMotion', () => {
  const vt = { reduced: false, viewTransitions: true };

  it('slides a push or pop with a View Transition where there are some, with Web Animations where not', () => {
    expect(navMotion('push', true, vt)).toBe('view-transition');
    expect(navMotion('pop', true, vt)).toBe('view-transition');
    expect(navMotion('push', true, { ...vt, viewTransitions: false })).toBe('animate');
  });

  it('is instant without a direction, when the motion already happened, or with Reduce Motion', () => {
    expect(navMotion('none', true, vt)).toBe('instant');
    expect(navMotion('pop', false, vt)).toBe('instant');
    expect(navMotion('push', true, { ...vt, reduced: true })).toBe('instant');
  });
});

describe('underPose', () => {
  it('sits 30% to the left and dimmed while covered, in place and full as the top page leaves', () => {
    expect(underPose(0, 400)).toEqual({ x: -120, opacity: UNDER_OPACITY });
    expect(underPose(200, 400)).toEqual({ x: -60, opacity: UNDER_OPACITY + (1 - UNDER_OPACITY) / 2 });
    expect(underPose(400, 400)).toEqual({ x: -0, opacity: 1 });
  });

  it('clamps past either end and treats a zero width as uncovered', () => {
    expect(underPose(-50, 400)).toEqual(underPose(0, 400));
    expect(underPose(900, 400)).toEqual(underPose(400, 400));
    expect(underPose(10, 0).opacity).toBe(1);
  });
});

describe('settleSwipe', () => {
  it('goes back past 40% of the width or on a flick to the right, at the finger\'s pace', () => {
    expect(settleSwipe(160, 0, 400, 300)).toEqual({ outcome: 'pop', durationMs: 300 });
    expect(settleSwipe(60, 0.5, 400, 300)).toEqual({ outcome: 'pop', durationMs: 300 }); // 340 px at 0.5 px/ms, clamped
    expect(settleSwipe(300, 1, 400, 300)).toEqual({ outcome: 'pop', durationMs: 150 }); // 100 px at 1 px/ms, the minimum
  });

  it('snaps back on a short drag or a flick to the left', () => {
    expect(settleSwipe(80, 0, 400, 300)).toEqual({ outcome: 'snap', durationMs: 300 });
    expect(settleSwipe(300, -1, 400, 300)).toEqual({ outcome: 'snap', durationMs: 300 });
    expect(settleSwipe(100, -0.2, 400, 300).outcome).toBe('snap');
  });
});

describe('swipeStart and swipeMove', () => {
  it('a touch near the left edge of a page that can go back is a candidate', () => {
    expect(swipeStart(0, { back: true, claimed: false })).toBe('pending');
    expect(swipeStart(EDGE, { back: true, claimed: false })).toBe('pending');
    expect(swipeStart(EDGE + 1, { back: true, claimed: false })).toBe('ignore');
    expect(swipeStart(5, { back: false, claimed: false })).toBe('ignore');
    expect(swipeStart(5, { back: true, claimed: true })).toBe('ignore');
  });

  it('becomes the swipe once it moves right, stays a scroll once it moves up or down or left', () => {
    expect(swipeMove('pending', 3, 2)).toBe('pending'); // still a tap
    expect(swipeMove('pending', 20, 4)).toBe('drag');
    expect(swipeMove('pending', 3, 20)).toBe('ignore'); // pull-to-refresh or a scroll
    expect(swipeMove('pending', -20, 1)).toBe('ignore');
    expect(swipeMove('drag', 0, 50)).toBe('drag'); // once dragging, a vertical wobble does not stop it
    expect(swipeMove('ignore', 50, 0)).toBe('ignore');
  });
});

describe('scrolledSideways', () => {
  const page = { scrollLeft: 0, parentElement: null };
  const block = { scrollLeft: 0, parentElement: page };
  const line = { scrollLeft: 0, parentElement: block };

  it('finds a code block scrolled sideways between the touch and the page', () => {
    expect(scrolledSideways(line, page)).toBe(false);
    block.scrollLeft = 30;
    expect(scrolledSideways(line, page)).toBe(true);
    block.scrollLeft = 0;
  });

  it('stops at the page and ignores things that are not elements', () => {
    const above = { scrollLeft: 10, parentElement: null };
    const stop = { scrollLeft: 0, parentElement: above };
    expect(scrolledSideways({ scrollLeft: 0, parentElement: stop }, stop)).toBe(false);
    expect(scrolledSideways(null, page)).toBe(false);
    expect(scrolledSideways('text', page)).toBe(false);
  });
});

describe('who owns the left edge', () => {
  it('knows iPhones and iPads (which say Macintosh but have touch)', () => {
    expect(isIOS({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: IPAD, maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: IPAD, maxTouchPoints: 0 })).toBe(false); // a Mac
    expect(isIOS({ userAgent: ANDROID, maxTouchPoints: 5 })).toBe(false);
  });

  it('leaves the edge to Safari in an iOS tab, and takes it in the installed app and elsewhere', () => {
    expect(ownsEdgeSwipe({ userAgent: IPHONE, maxTouchPoints: 5, standalone: false })).toBe(false);
    expect(ownsEdgeSwipe({ userAgent: IPHONE, maxTouchPoints: 5, standalone: true })).toBe(true);
    expect(ownsEdgeSwipe({ userAgent: ANDROID, maxTouchPoints: 5, standalone: false })).toBe(true);
  });
});

describe('guessBrowserSwipe', () => {
  const tab = { ownsEdge: false, down: false, lastEnd: 0, now: 10_000 };

  it('believes the browser when it says', () => {
    expect(guessBrowserSwipe({ hasUAVisualTransition: true }, { ...tab, ownsEdge: true })).toBe(true);
    expect(guessBrowserSwipe({ hasUAVisualTransition: false }, { ...tab, down: true })).toBe(false);
  });

  it('in an iOS tab, takes a pop during or right after a touch for Safari\'s swipe', () => {
    expect(guessBrowserSwipe({}, { ...tab, down: true })).toBe(true);
    expect(guessBrowserSwipe({}, { ...tab, lastEnd: 9_700 })).toBe(true);
    expect(guessBrowserSwipe({}, { ...tab, lastEnd: 9_000 })).toBe(false); // the back button
  });

  it('never guesses where the edge swipe is the app\'s', () => {
    expect(guessBrowserSwipe({}, { ...tab, ownsEdge: true, down: true })).toBe(false);
  });
});
