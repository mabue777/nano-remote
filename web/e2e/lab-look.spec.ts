import { expect, test, type Locator, type Page } from './worker-host';

// The lab's Look switch (src/lab/look.ts, NewLook.tsx, new-look.css): Now is today's design, New the redesign.
// The switch flips and is remembered, the motion buttons (All Now / All Smooth) leave it alone, and the New
// look's path (list -> session -> sheets, approve, answer a question, send, stop, back) works in light and
// dark with every motion switch. Screenshots go to /tmp/look-shots/ (not the repo) for the operator and the
// doc. The fake stream runs 8x faster (?speed=8).

// Every test opens the lab on its own page against its own in-browser fake stream (no fake host state,
// distinct screenshot names), so they spread over the workers; one worker alone took about 170 s.
test.describe.configure({ mode: 'parallel' });

const SHOTS = '/tmp/look-shots';
const TECHNIQUES = ['Press feedback', 'Page push and back swipe', 'Sheets', 'Streaming text', 'Auto-scroll', 'Sending', 'Keyboard', 'List changes', 'Expand and collapse', 'Haptic tick'];

async function openPanel(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Lab' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Sets the look and the motion switches: 'Now' / 'Smooth' for all, or one technique on Smooth and the rest Now. */
async function configure(page: Page, look: 'Now' | 'New', motion: 'Now' | 'Smooth' | { only: string }): Promise<void> {
  const panel = await openPanel(page);
  await panel.getByRole('group', { name: 'Look' }).getByRole('button', { name: look, exact: true }).click();
  if (typeof motion === 'string') await panel.getByRole('button', { name: `All ${motion}` }).click();
  else {
    await panel.getByRole('button', { name: 'All Now' }).click();
    await panel.getByRole('group', { name: motion.only }).getByRole('button', { name: 'Smooth' }).click();
  }
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toBeHidden();
}

/** Waits until no sheet moves and no closed sheet is left on the page. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll('.sheet, .lab-scrim')].every((el) => el.getAnimations().length === 0)))
    .toBe(true);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350); // entrances and fades end, so the picture shows the resting state
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('the Look switch flips between Now and New, is remembered, and the motion buttons leave it alone', async ({ page }) => {
  await page.goto('/lab');
  const lab = page.locator('.lab');
  await expect(lab).toHaveAttribute('data-look', 'now');
  await expect(page.getByRole('button', { name: 'Simulate activity' })).toBeVisible();

  const panel = await openPanel(page);
  const look = panel.getByRole('group', { name: 'Look' });
  await expect(look.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'true');
  await look.getByRole('button', { name: 'New' }).click();
  await expect(lab).toHaveAttribute('data-look', 'new');
  await expect(look.getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'All Smooth' }).click();
  await expect(lab).toHaveAttribute('data-look', 'new');
  await expect(lab).toHaveAttribute('data-sheet', 'smooth');
  await panel.getByRole('button', { name: 'All Now' }).click();
  await expect(lab).toHaveAttribute('data-look', 'new');
  await panel.getByRole('button', { name: 'Done' }).click();

  // The New list: host chips, round + button, one trailing indicator per row.
  await expect(page.getByRole('group', { name: 'Hosts' }).getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  await expect(page.locator('.lab-nl-row')).toHaveCount(5);
  await expect(page.locator('.lab-nl-row .row-sign[data-sign="needs"]')).toHaveText(['Needs approval', 'Needs your answer']);

  await page.reload();
  await expect(lab).toHaveAttribute('data-look', 'new'); // kept in localStorage
  const again = await openPanel(page);
  await again.getByRole('group', { name: 'Look' }).getByRole('button', { name: 'Now' }).click();
  await expect(lab).toHaveAttribute('data-look', 'now');
  await expect(page.locator('.lab-nl-row')).toHaveCount(0);
});

test('the real screens wear the New look tokens (look adoption step 1); the lab Now look keeps the earlier ones', async ({ page }) => {
  await page.goto('/lab');
  await configure(page, 'New', 'Now');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const primary = (selector: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).getPropertyValue('--primary').trim(), selector);
  expect(await bg()).toBe('rgb(250, 250, 248)'); // --bg of the New look: the warm page (look polish)
  expect(await primary('.lab')).toBe('#1a1917');
  await configure(page, 'Now', 'Now');
  expect(await bg()).toBe('rgb(246, 246, 244)'); // the earlier --bg, from now-look.css
  expect(await primary('.lab')).toBe('#2f5bd3'); // the earlier blue main button
  // The real pages load none of the lab's stylesheets and use the app's tokens.
  await page.goto('/pair');
  expect(await primary('html')).toBe('#1a1917');
  expect(await bg()).toBe('rgb(250, 250, 248)');
  expect(await page.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes('data-look'))))).toBe(false);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`today's look, ${scheme}: reference screenshots`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/lab?speed=8');
    await configure(page, 'Now', 'Now');
    await shot(page, `now-${scheme}-1-list`);
    await page.getByRole('list', { name: 'Sessions' }).getByRole('link', { name: /Fix the failing parser test/ }).click();
    const conversation = page.getByRole('region', { name: 'Conversation' });
    await expect(conversation.getByRole('group', { name: 'Approval: Run a command?' })).toBeVisible({ timeout: 15_000 });
    await shot(page, `now-${scheme}-2-session`);
  });

  for (const motion of ['Now', 'Smooth'] as const) {
    test(`New look, ${scheme}, motion all ${motion}: list -> session -> sheets, approve, answer, send, stop, back`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/lab?speed=8');
      await configure(page, 'New', motion);
      const name = (step: string) => `new-${scheme}-${motion.toLowerCase()}-${step}`;
      const sessions = page.getByRole('list', { name: 'Sessions' });
      await expect(sessions.getByRole('link')).toHaveCount(5);
      if (motion === 'Now') await shot(page, name('1-list'));

      // Host chips filter the list; All brings every row back.
      const hosts = page.getByRole('group', { name: 'Hosts' });
      await hosts.getByRole('button', { name: 'MacBook Pro' }).click();
      await expect(hosts.getByRole('button', { name: 'MacBook Pro' })).toHaveAttribute('aria-pressed', 'true');
      await expect(sessions.getByRole('link')).toHaveCount(2);
      await hosts.getByRole('button', { name: 'All' }).click();
      await expect(sessions.getByRole('link')).toHaveCount(5);
      await page.getByRole('button', { name: 'Simulate activity' }).click();
      await expect(sessions.getByRole('link').first()).toContainText('Fix the lint warnings');

      // New session sheet (ink primary button).
      await page.getByRole('button', { name: 'New session' }).click();
      const create = page.getByRole('dialog', { name: 'New session' });
      await expect(create).toBeVisible();
      await settled(page);
      if (motion === 'Now') await shot(page, name('2-new-session-sheet'));
      expect(await create.getByRole('button', { name: 'Start session' }).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(scheme === 'light' ? 'rgb(26, 25, 23)' : 'rgb(255, 255, 255)');
      await create.getByRole('button', { name: 'Cancel' }).click();
      await expect(create).toBeHidden();

      // Into the session: centred header, flat tool rows, Thinking, then the answer.
      await sessions.getByRole('link', { name: /Fix the failing parser test/ }).click();
      await expect(page.getByRole('heading', { name: 'Fix the failing parser test' })).toBeVisible();
      await expect(page.getByText('Mac mini · nano-remote', { exact: true })).toBeVisible();
      const conversation = page.getByRole('region', { name: 'Conversation' });
      await expect(conversation.getByRole('button', { name: /Ran npm test -- parser/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible(); // running: the trailing button is Stop
      await expect(conversation).toContainText('push the fix to a branch', { timeout: 15_000 });

      // Finished: the work folds behind "3 previous messages", "Worked for 3m …", the quiet approval card.
      const approval = conversation.getByRole('group', { name: 'Approval: Run a command?' });
      await expect(approval).toBeVisible();
      await expect(conversation.getByText(/^Worked for 3m \d+s$/)).toBeVisible();
      await expect(conversation.getByRole('button', { name: /Ran npm test -- parser/ })).toHaveCount(0);
      await expect(approval.getByRole('button')).toHaveText(['Accept', 'Decline', 'More']);
      await shot(page, name('3-session-approval'));
      await conversation.getByRole('button', { name: '3 previous messages' }).click();
      const tool = conversation.getByRole('button', { name: /Ran npm test -- parser/ });
      await tool.click();
      await expect(conversation.getByText('Tests  1 failed | 11 passed (12)')).toBeVisible();
      if (motion === 'Now') await shot(page, name('4-tool-open'));
      await tool.click();
      await expect(conversation.getByText('Tests  1 failed | 11 passed (12)')).toBeHidden();
      await conversation.getByRole('button', { name: '3 previous messages' }).click();
      await expect(tool).toHaveCount(0);

      // The ⋯ sheet carries what the old header showed, and leads to Changes.
      await page.getByRole('button', { name: 'Session details' }).click();
      const details = page.getByRole('dialog', { name: 'Fix the failing parser test' });
      await expect(details).toBeVisible();
      await expect(details.getByRole('list', { name: 'Session details' })).toContainText('Waiting for your approval');
      await settled(page);
      await shot(page, name('5-details-sheet'));
      await details.getByRole('button', { name: /Changes/ }).click();
      const changes = page.getByRole('dialog', { name: 'Changes' });
      await expect(changes).toBeVisible();
      await expect(changes.getByRole('list', { name: 'Changed files' }).getByRole('listitem')).toHaveCount(3);
      await settled(page);
      if (motion === 'Now') await shot(page, name('6-changes-sheet'));
      await changes.getByRole('button', { name: 'Close' }).click();
      await expect(changes).toBeHidden();
      // The same sheet from the inline card.
      await conversation.getByRole('button', { name: /3 files changed/ }).click();
      await expect(changes).toBeVisible();
      await changes.getByRole('button', { name: 'Close' }).click();
      await expect(changes).toBeHidden();

      // More shows the other two choices; Accept answers, and the card keeps its place with a check.
      await approval.getByRole('button', { name: 'More' }).click();
      await expect(approval.getByRole('group', { name: 'More choices' }).getByRole('button')).toHaveText(['Accept for this session', 'Cancel the turn']);
      await approval.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(conversation.getByLabel('Approval answered')).toContainText('Approved');

      // Send: the bubble shows at once, the reply streams and ends in a question card.
      const field = page.getByRole('textbox', { name: 'Message' });
      await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
      await field.fill('Keep it small.\nNo refactor.');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(field).toHaveValue('');
      await expect(conversation.locator('.msg.user').last()).toContainText('Keep it small.');
      const question = conversation.getByRole('group', { name: 'Question: Which branch should I push to?' });
      await expect(question).toBeVisible({ timeout: 15_000 });
      await expect(question.getByRole('button', { name: 'Send answer' })).toBeDisabled();
      await question.getByText('lab-fix', { exact: true }).click();
      await shot(page, name('7-question'));
      await question.getByRole('button', { name: 'Send answer' }).click();
      await expect(conversation.getByLabel('Question answered')).toContainText('lab-fix');

      // While a reply runs, the trailing button is Stop; Stop ends the turn where it is.
      await field.fill('One more check.');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(conversation.getByText(/^Stopped after \d+s$/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

      // The + sheet opens and closes.
      await page.getByRole('button', { name: 'Add files' }).click();
      const add = page.getByRole('dialog', { name: 'Add to message' });
      await expect(add).toBeVisible();
      await add.getByRole('button', { name: 'Cancel' }).click();
      await expect(add).toBeHidden();

      // Back to the list with the round back button.
      await page.getByRole('link', { name: 'Back to sessions' }).click();
      await expect(sessions).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Fix the failing parser test' })).toBeHidden();
    });
  }

  test(`New look, ${scheme}: each motion switch alone on Smooth`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/lab?speed=40'); // the stream itself is covered above; here only the switches vary
    for (const only of TECHNIQUES) {
      await configure(page, 'New', { only });
      const sessions = page.getByRole('list', { name: 'Sessions' });
      await sessions.getByRole('link', { name: /Fix the failing parser test/ }).click();
      const conversation = page.getByRole('region', { name: 'Conversation' });
      const approval = conversation.getByRole('group', { name: 'Approval: Run a command?' });
      await expect(approval, only).toBeVisible({ timeout: 15_000 });
      await conversation.getByRole('button', { name: '3 previous messages' }).click();
      await expect(conversation.getByRole('button', { name: /Edited src\/parser.ts/ }), only).toBeVisible();
      await page.getByRole('button', { name: 'Session details' }).click();
      const details = page.getByRole('dialog', { name: 'Fix the failing parser test' });
      await expect(details, only).toBeVisible();
      await details.getByRole('button', { name: 'Done' }).click();
      await expect(details, only).toBeHidden();
      await approval.getByRole('button', { name: 'Decline' }).click();
      await expect(conversation.getByLabel('Approval answered'), only).toContainText('Declined');
      await page.getByRole('textbox', { name: 'Message' }).fill('Thanks.');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(conversation.locator('.msg.user').last(), only).toContainText('Thanks.');
      await page.getByRole('link', { name: 'Back to sessions' }).click();
      await expect(sessions, only).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Fix the failing parser test' }), only).toBeHidden();
    }
  });
}
