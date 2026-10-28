import { expect, test, type CDPSession, type Page } from './worker-host';

// Smoothness check for the lab's Smooth techniques (docs/research/interaction-feel-prototype.md). Not part
// of the gate: run it on purpose with
//
//   LAB_PERF=1 pnpm exec playwright test lab-perf
//
// For each technique it runs the gesture with every switch on Smooth and records:
//   - long tasks (PerformanceObserver 'longtask': the main thread blocked > 50 ms, a sure dropped frame);
//   - main-thread time from the DevTools protocol (Performance.getMetrics: script, style, layout, and the
//     number of layouts), as a share of the wall time the gesture took;
//   - every CSS property any running animation touches (document.getAnimations() sampled every 25 ms), to
//     prove only transform and opacity move.
// Frame gaps are not measured: headless Chromium on the build Mac does not pace animation frames at the
// display rate even on a blank page (median gaps 33-100 ms, measured 2026-10-24), so the frame rate itself
// has to be judged on the phone. It runs at full speed and with the CPU slowed 4x (DevTools protocol), a
// rough stand-in for an older phone. One JSON line per technique goes to the console.

test.skip(process.env.LAB_PERF !== '1', 'opt-in measurement; set LAB_PERF=1');
test.setTimeout(180_000);

interface Stats {
  technique: string;
  cpu: number;
  wallMs: number;
  longTasks: number;
  longestTaskMs: number;
  /** Main-thread busy time (script + style + layout + other tasks) as a share of wall time. */
  busyPct: number;
  scriptMs: number;
  styleMs: number;
  layoutMs: number;
  layouts: number;
  animated: string[];
}

type Metrics = Record<string, number>;

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: list } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

async function arm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { tasks: number[]; props: Set<string>; timer?: number } };
    if (w.__perf === undefined) {
      w.__perf = { tasks: [], props: new Set() };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__perf.tasks.push(e.duration);
      }).observe({ type: 'longtask' });
    }
    w.__perf.tasks = [];
    w.__perf.props = new Set();
    const skip = new Set(['offset', 'computedOffset', 'easing', 'composite']);
    w.__perf.timer = window.setInterval(() => {
      for (const a of document.getAnimations()) {
        const effect = a.effect as KeyframeEffect | null;
        for (const k of effect?.getKeyframes() ?? []) for (const p of Object.keys(k)) if (!skip.has(p)) w.__perf.props.add(p);
        if (a instanceof CSSTransition) w.__perf.props.add(a.transitionProperty);
      }
    }, 25);
  });
}

async function measure(page: Page, cdp: CDPSession, technique: string, cpu: number, run: () => Promise<void>): Promise<Stats> {
  await arm(page);
  const before = await metrics(cdp);
  const t0 = Date.now();
  await run();
  const wallMs = Date.now() - t0;
  const after = await metrics(cdp);
  const raw = await page.evaluate(() => {
    const w = window as unknown as { __perf: { tasks: number[]; props: Set<string>; timer?: number } };
    window.clearInterval(w.__perf.timer);
    return { tasks: w.__perf.tasks, props: [...w.__perf.props].sort() };
  });
  const d = (name: string) => Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000);
  const stats: Stats = {
    technique,
    cpu,
    wallMs,
    longTasks: raw.tasks.length,
    longestTaskMs: Math.round(Math.max(0, ...raw.tasks)),
    busyPct: Math.round((d('TaskDuration') / wallMs) * 1000) / 10,
    scriptMs: d('ScriptDuration'),
    styleMs: d('RecalcStyleDuration'),
    layoutMs: d('LayoutDuration'),
    layouts: Math.round((after.LayoutCount ?? 0) - (before.LayoutCount ?? 0)),
    animated: raw.props,
  };
  console.log(`LAB_PERF ${JSON.stringify(stats)}`);
  return stats;
}

for (const cpu of [1, 4]) {
  test(`Smooth techniques: long tasks, main-thread time, animated properties (CPU ${cpu}x)`, async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await cdp.send('Performance.enable');
    await page.goto('/lab');
    await page.getByRole('button', { name: 'Lab', exact: true }).click();
    await page.getByRole('button', { name: 'All Smooth' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    const sessions = page.getByRole('list', { name: 'Sessions' });
    const row = sessions.getByRole('link', { name: /Fix the failing parser test/ });

    await measure(page, cdp, 'press', cpu, async () => {
      const box = (await row.boundingBox())!;
      await page.mouse.move(box.x + 40, box.y + 20);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.move(box.x + 40, box.y - 200); // slide off: no tap
      await page.mouse.up();
      await page.waitForTimeout(300);
    });

    await measure(page, cdp, 'list', cpu, async () => {
      for (let i = 0; i < 4; i++) {
        await page.getByRole('button', { name: 'Simulate activity' }).click();
        await page.waitForTimeout(450);
      }
    });

    await measure(page, cdp, 'sheet', cpu, async () => {
      await page.getByRole('button', { name: 'New session' }).click();
      await page.waitForTimeout(800);
      await page.getByRole('dialog', { name: 'New session' }).getByRole('button', { name: 'Cancel' }).click();
      await page.waitForTimeout(500);
    });

    await measure(page, cdp, 'page', cpu, async () => {
      await row.click();
      await page.waitForTimeout(600);
      await page.getByRole('link', { name: 'Sessions', exact: true }).click();
      await page.waitForTimeout(600);
      await row.click();
      await page.waitForTimeout(600);
    });

    const conversation = page.getByRole('region', { name: 'Conversation' });
    await measure(page, cdp, 'stream', cpu, async () => {
      await page.waitForTimeout(5000); // Thinking, then the answer streams (real speed)
    });

    await measure(page, cdp, 'scroll', cpu, async () => {
      const box = (await conversation.boundingBox())!;
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(600);
      const pill = page.getByRole('button', { name: 'Jump to latest ↓' });
      if (await pill.isVisible()) await pill.click();
      await page.waitForTimeout(900);
    });

    await expect(conversation).toContainText('push the fix to a branch', { timeout: 60_000 });
    await measure(page, cdp, 'expand', cpu, async () => {
      const tool = conversation.getByRole('button', { name: /npm test -- parser/ });
      for (let i = 0; i < 4; i++) {
        await tool.click();
        await page.waitForTimeout(450);
      }
      await conversation.getByRole('button', { name: 'Accept' }).click();
      await page.waitForTimeout(500);
    });

    await measure(page, cdp, 'send', cpu, async () => {
      await page.getByRole('textbox', { name: 'Message' }).fill('Keep it small.\nNo refactor.\nThanks.');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForTimeout(800);
    });
  });
}
