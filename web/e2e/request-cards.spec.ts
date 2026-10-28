import { expect, test, type APIRequestContext, type Locator, type Page } from './worker-host';

import { closeDetails, openDetails, sheetsSettled } from './sheets';

// The quiet approval and question cards (look step 4; RequestCards.tsx) against the fake host
// (test/e2e-server.ts): Accept and Decline in the row, the other decisions under More, the card turning
// into one answered line in its place, questions with round checks and an "Other…" row, a blocking question
// on the composer bar, a request answered on another device naming it, one status on the session screen
// (the header's dot and word), and "Full access" after it in plain grey.

const DESKTOP = 'Mabue MacBook'; // the fake host's device/list name for dev_desktop

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function pair(page: Page, request: APIRequestContext): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('status')).toHaveAttribute('data-state', 'connected');
}

async function lastParams(request: APIRequestContext, method: string): Promise<Record<string, unknown> | null> {
  return ((await (await request.post('/test/last', { data: { method } })).json()) as { params: Record<string, unknown> | null }).params;
}

async function addRequest(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  return ((await (await request.post('/test/request', { data: { sessionId: 'ses_fake_3', request: body } })).json()) as { requestId: string }).requestId;
}

async function openEmpty(page: Page, request: APIRequestContext): Promise<void> {
  await pair(page, request);
  await page.goto('/s/ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
}

const conversation = (page: Page) => page.getByRole('region', { name: 'Conversation' });
const commandCard = (page: Page) => page.getByRole('group', { name: 'Approval: Run this command?' });

/** The card's grey: the shell layer's background, else the card's own. */
async function cardFill(card: Locator): Promise<string> {
  return card.evaluate((el) => {
    const shell = el.querySelector(':scope > .shell');
    return getComputedStyle(shell ?? el).backgroundColor;
  });
}

async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('div');
    probe.style.background = `var(${n})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, name);
}

test('approval: a quiet grey card; Accept turns it into "Approved" in the same place', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/s/ses_fake_2'); // seeded waiting for its command approval
  const card = commandCard(page);
  await expect(card).toBeVisible();
  // One status: the header's dot and word. No "N approvals waiting" line, no task-state line.
  await expect(page.getByLabel('Session status')).toHaveText('Needs approval');
  await expect(page.getByRole('alert', { name: 'Needs your decision' })).toHaveCount(0);
  await expect(page.getByLabel('Task state')).toHaveCount(0);
  await expect(page.locator('.decision-notice, .task-state, .request-notice')).toHaveCount(0);

  // The card: grey fill, no border; the command in a white inner box with the folder and the reason.
  expect(await cardFill(card)).toBe(await token(page, '--fill'));
  expect(await card.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
  const inner = card.locator('.request-inner');
  expect(await inner.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await token(page, '--surface'));
  await expect(inner).toContainText('echo hello > hello.txt');
  await expect(inner).toContainText('in /Users/me/Desktop/phone-test · May I create hello.txt in the current directory?');
  await expect(card.getByRole('button')).toHaveText(['Accept', 'Decline', 'More']);
  // Accept is the ink pill, Decline a grey pill.
  const accept = card.getByRole('button', { name: 'Accept', exact: true });
  expect(await accept.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await token(page, '--primary'));
  expect(await card.getByRole('button', { name: 'Decline' }).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await token(page, '--fill-strong'));

  const before = (await card.boundingBox())!;
  await accept.click();
  await expect(card).toHaveCount(0);
  const line = conversation(page).getByLabel('Approval answered');
  await expect(line).toContainText('Run this command?');
  await expect(line).toContainText('Approved');
  await expect(line).toHaveAttribute('data-tone', 'ok');
  expect(await lastParams(request, 'approval/resolve')).toMatchObject({ sessionId: 'ses_fake_2', decision: 'accept' });
  // One line high, and where the card was (its top edge within a row of the card's; the turn goes on below).
  await expect.poll(async () => (await line.boundingBox())!.height).toBeLessThan(60);
  await page.waitForTimeout(400); // the collapse settles (300 ms)
  const after = (await line.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(80);
  // It stays: the turn finishes, the line is still there.
  await expect(page.getByLabel('Session status')).toHaveText('Finished');
  await expect(conversation(page).getByLabel('Approval answered')).toContainText('Approved');
});

test('approval: More opens Accept for this session and Cancel the turn in place; Decline leaves "Declined"', async ({ page, request }) => {
  await openEmpty(page, request);
  const all = ['accept', 'acceptForSession', 'decline', 'cancel'];
  const first = await addRequest(request, { kind: 'command', command: 'pnpm test', cwd: '/Users/me/code', reason: 'Run the tests.', availableDecisions: all });
  const card = page.locator(`[data-request-id="${first}"]`);
  await expect(card.getByRole('group', { name: 'More choices' })).toHaveCount(0);
  await card.getByRole('button', { name: 'More' }).click();
  await expect(card.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
  await expect(card.getByRole('group', { name: 'More choices' }).getByRole('button')).toHaveText(['Accept for this session', 'Cancel the turn']);
  await card.getByRole('button', { name: 'Accept for this session' }).click();
  await expect(conversation(page).locator(`[data-request-id="${first}"]`)).toHaveText(/Accepted for this session/);
  expect(await lastParams(request, 'approval/resolve')).toMatchObject({ requestId: first, decision: 'acceptForSession' });

  const second = await addRequest(request, { kind: 'command', command: 'rm -rf build', cwd: '/Users/me/code', availableDecisions: all });
  await page.locator(`[data-request-id="${second}"]`).getByRole('button', { name: 'Decline' }).click();
  const declined = page.locator(`[data-request-id="${second}"]`);
  await expect(declined).toHaveAttribute('aria-label', 'Approval answered');
  await expect(declined).toContainText('Declined');
  await expect(declined).toHaveAttribute('data-tone', 'muted');

  const third = await addRequest(request, { kind: 'command', command: 'git push --force', cwd: '/Users/me/code', availableDecisions: all });
  await page.locator(`[data-request-id="${third}"]`).getByRole('button', { name: 'More' }).click();
  await page.locator(`[data-request-id="${third}"]`).getByRole('button', { name: 'Cancel the turn' }).click();
  await expect(page.locator(`[data-request-id="${third}"]`)).toContainText('Turn cancelled');
  expect(await lastParams(request, 'approval/resolve')).toMatchObject({ requestId: third, decision: 'cancel' });
  // All three lines stay, in order.
  await expect(conversation(page).locator('.request-answered')).toHaveCount(3);
});

test('approval: every button is disabled while a decision is in flight', async ({ page, request }) => {
  await openEmpty(page, request);
  const id = await addRequest(request, { kind: 'command', command: 'make', cwd: '/Users/me/code', availableDecisions: ['accept', 'decline'] });
  const card = page.locator(`[data-request-id="${id}"]`);
  await request.post('/test/delay', { data: { method: 'approval/resolve', ms: 800 } });
  await card.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Decline' })).toBeDisabled();
  await expect(card).toHaveAttribute('aria-label', 'Approval answered');
});

test('approval answered on another device: the line names the device', async ({ page, request }) => {
  await pair(page, request);
  await page.goto('/s/ses_fake_2');
  await expect(commandCard(page)).toBeVisible();
  await request.post('/test/resolve', { data: { sessionId: 'ses_fake_2', decision: 'decline' } });
  await expect(commandCard(page)).toHaveCount(0);
  const line = conversation(page).getByLabel('Approval answered');
  await expect(line).toContainText(`Declined on ${DESKTOP}`);
  await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
});

test('question, one choice: round checks in one inner box; Send answer; the answer stays as the line', async ({ page, request }) => {
  await openEmpty(page, request);
  await addRequest(request, {
    kind: 'input',
    isBlocking: false,
    questions: [
      {
        id: 'branch',
        header: 'Branch',
        question: 'Which branch should I push to?',
        options: [
          { label: 'fix-parser', description: 'The branch with the fix' },
          { label: 'main', description: 'Straight to the default branch' },
        ],
        isOther: true,
        isSecret: false,
      },
    ],
  });
  const card = conversation(page).getByRole('group', { name: 'Question: Which branch should I push to?' });
  await expect(card).toBeVisible();
  await expect(card.locator('.request-inner .option')).toHaveCount(3); // two options and "Other…", one box
  await expect(card.locator('.option').last()).toContainText('Other…');
  await expect(card.locator('.option-mark.radio')).toHaveCount(3);
  await expect(card.getByRole('textbox')).toHaveCount(0); // the Other field shows once chosen
  const send = card.getByRole('button', { name: 'Send answer' });
  await expect(send).toBeDisabled();
  await card.getByText('fix-parser', { exact: true }).click();
  await expect(card.getByRole('radio', { name: /fix-parser/ })).toBeChecked();
  await send.click();
  expect(await lastParams(request, 'input/answer')).toMatchObject({ answers: { branch: ['fix-parser'] } });
  const line = conversation(page).getByLabel('Question answered');
  await expect(line).toContainText('Which branch should I push to?');
  await expect(line).toContainText('fix-parser');
});

test('question, several picks with Other: check look, Other reveals its field, the answer joins them', async ({ page, request }) => {
  await openEmpty(page, request);
  await addRequest(request, {
    kind: 'input',
    isBlocking: false,
    questions: [
      {
        id: 'sections',
        header: 'Sections',
        question: 'Which sections should the README have?',
        options: [
          { label: 'Install', description: 'How to install.' },
          { label: 'Usage', description: '' },
        ],
        multiSelect: true,
        isOther: true,
        isSecret: false,
      },
      { id: 'tone', header: 'Tone', question: 'Which tone?', options: [{ label: 'Plain', description: '' }, { label: 'Playful', description: '' }], isOther: false, isSecret: false },
    ],
  });
  const card = conversation(page).getByRole('group', { name: 'Question: 2 questions' });
  await expect(card).toBeVisible();
  // Two question groups in one card, each with its own legend and box.
  await expect(card.locator('fieldset.question-field')).toHaveCount(2);
  await expect(card.locator('.question-legend').first()).toContainText('Which sections should the README have? (pick any)');
  await expect(card.locator('fieldset[data-question-id="sections"] .option-mark.checkbox')).toHaveCount(3);
  await expect(card.locator('fieldset[data-question-id="tone"] .option-mark.radio')).toHaveCount(2);

  await card.getByText('Usage', { exact: true }).click();
  await card.getByText('Install', { exact: true }).click();
  await card.getByText('Other…', { exact: true }).click();
  const other = card.getByRole('textbox', { name: 'Other answer to Sections' });
  await expect(other).toBeFocused();
  await other.fill('FAQ');
  await card.getByText('Plain', { exact: true }).click();
  await card.getByRole('button', { name: 'Send answer' }).click();
  expect(await lastParams(request, 'input/answer')).toMatchObject({ answers: { sections: ['Install', 'Usage', 'FAQ'], tone: ['Plain'] } });
  await expect(conversation(page).getByLabel('Question answered')).toContainText('Install, Usage, FAQ · Plain');
});

test('a blocking question rides on the composer bar, restyled; answered, its line is in the conversation', async ({ page, request }) => {
  await openEmpty(page, request);
  await addRequest(request, {
    kind: 'input',
    isBlocking: true,
    questions: [{ id: 'ok', header: '', question: 'Go ahead with the rewrite?', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], isOther: false, isSecret: false }],
  });
  const pinned = page.locator('footer.composer-bar').getByRole('region', { name: 'Waiting for your answer' });
  const card = pinned.getByRole('group', { name: 'Question: Go ahead with the rewrite?' });
  await expect(card).toBeVisible();
  expect(await cardFill(card)).toBe(await token(page, '--fill'));
  await expect(conversation(page).getByRole('group', { name: /^Question:/ })).toHaveCount(0);
  await card.getByText('Yes', { exact: true }).click();
  await card.getByRole('button', { name: 'Send answer' }).click();
  await expect(pinned).toHaveCount(0);
  await expect(conversation(page).getByLabel('Question answered')).toContainText('Yes');
});

test('a question answered on another device names it, with the answer it sent', async ({ page, request }) => {
  await openEmpty(page, request);
  const id = await addRequest(request, {
    kind: 'input',
    isBlocking: false,
    questions: [{ id: 'ok', header: '', question: 'Ship it?', options: [{ label: 'Yes', description: '' }], isOther: false, isSecret: false }],
  });
  await expect(conversation(page).getByRole('group', { name: 'Question: Ship it?' })).toBeVisible();
  await request.post('/test/resolve-request', { data: { sessionId: 'ses_fake_3', requestId: id, answers: { ok: ['Yes'] } } });
  await expect(conversation(page).getByLabel('Question answered')).toContainText(`Answered on ${DESKTOP}: Yes`);
});

test('a Bypass session says "Full access" in plain grey after the status, and in the ⋯ sheet\'s Permissions row', async ({ page, request }) => {
  await pair(page, request);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  await sheetsSettled(page);
  await sheet.getByRole('switch', { name: 'Bypass approvals (full access)' }).click();
  await sheet.getByLabel('Title (optional)').fill('Full access session');
  await sheet.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/s\/ses_fake_\d+$/);
  await sheetsSettled(page);
  const footnote = page.locator('.nav-footnote');
  await expect(footnote).toHaveText(/^(Idle|Finished|Working · \d+s) · Full access$/);
  const extra = footnote.locator('.nav-extra');
  await expect(extra).toHaveText(' · Full access');
  const style = await extra.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor };
  });
  expect(style).toEqual({ color: await token(page, '--muted'), background: 'rgba(0, 0, 0, 0)' });
  await expect(page.getByLabel('Approvals bypassed')).toHaveCount(0); // no tag any more
  const details = await openDetails(page);
  await expect(details.locator('[data-row="permissions"]')).toHaveText(/Permissions\s*Full access/);
  await closeDetails(page, details);
});
