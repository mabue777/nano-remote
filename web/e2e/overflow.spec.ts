import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Long unbroken text never runs past a card at phone width (field check 2026-10-21, defect 2: a thinking
// block with ["touch","/Users/..."] ran past its right border). Every transcript item kind and both request
// cards render a 120-character token with no break opportunity; no element and no line of text may end
// right of its card, and the page never scrolls sideways.

const TOKEN = `["touch","/Users/mabue/Desktop/${'outside_'.repeat(20)}`.slice(0, 118) + '"]';

test.beforeEach(async ({ request }) => {
  await request.post('/test/reset');
});

async function openSession(page: Page, request: APIRequestContext, sessionId: string): Promise<void> {
  const code = ((await (await request.post('/test/code')).json()) as { code: string }).code;
  await page.goto(`/pair#code=${code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/s/${sessionId}`);
}

/**
 * For every card: the right edge of each descendant element, and of each text node (clipped by any
 * ancestor inside the card that hides or scrolls its overflow), minus the card's right edge. Positive
 * values are overflow.
 */
async function overflows(page: Page, selector: string): Promise<{ card: string; what: string; by: number }[]> {
  return page.locator(selector).evaluateAll((cards) => {
    const found: { card: string; what: string; by: number }[] = [];
    for (const card of cards) {
      const limit = card.getBoundingClientRect().right;
      const name = card.getAttribute('data-item') ?? card.getAttribute('aria-label') ?? card.className;
      const clipped = (node: Node, right: number): number => {
        for (let el = node.parentElement; el !== null && el !== card; el = el.parentElement) {
          if (getComputedStyle(el).overflowX !== 'visible') right = Math.min(right, el.getBoundingClientRect().right);
        }
        return right;
      };
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        let right: number;
        if (node instanceof Element) {
          right = clipped(node, node.getBoundingClientRect().right);
        } else {
          if ((node.textContent ?? '').trim() === '') continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          right = clipped(node, range.getBoundingClientRect().right);
        }
        if (right > limit + 0.5) {
          const what = node instanceof Element ? `<${node.tagName.toLowerCase()} class="${node.className}">` : `text "${(node.textContent ?? '').slice(0, 30)}"`;
          found.push({ card: name, what, by: Math.round(right - limit) });
        }
      }
      if (limit > window.innerWidth + 0.5) found.push({ card: name, what: 'the card itself', by: Math.round(limit - window.innerWidth) });
    }
    return found;
  });
}

const pageWidth = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth);

test('every transcript item kind wraps a 120-character unbroken token inside its card at 390 px', async ({ page, request }) => {
  expect(TOKEN).toHaveLength(120);
  expect(TOKEN).not.toMatch(/\s/);
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await request.post('/test/items', {
    data: {
      sessionId: 'ses_fake_3',
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: TOKEN }] },
        { type: 'reasoning', summary: TOKEN, text: `${TOKEN}\n${TOKEN}` },
        { type: 'agentMessage', text: TOKEN },
        { type: 'command', command: TOKEN, cwd: `/${TOKEN}`, output: TOKEN, exitCode: 0, durationMs: 10 },
        { type: 'fileChange', changes: [{ path: TOKEN, kind: 'add', diff: `+${TOKEN}\n` }] },
        { type: 'toolCall', tool: TOKEN, arguments: { path: TOKEN }, error: TOKEN },
        { type: 'plan', text: TOKEN },
        { type: 'other', raw: { kind: TOKEN } },
      ],
    },
  });

  // The finished turn folds its work; open it and every row's content.
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await conversation.getByRole('button', { name: '6 previous messages' }).click();
  for (const kind of ['user', 'reasoning', 'agent', 'command', 'fileChange', 'tool', 'plan', 'other']) {
    await expect(conversation.locator(`[data-item="${kind}"]`)).toHaveCount(1);
  }
  for (const kind of ['reasoning', 'command', 'fileChange', 'tool', 'plan']) {
    const row = conversation.locator(`[data-item="${kind}"]`);
    await row.getByRole('button', { expanded: false }).click();
    await expect(row.locator('.row-body')).toContainText(TOKEN.slice(0, 40));
  }
  await expect(conversation.locator('[data-item="agent"]')).toContainText(TOKEN.slice(0, 40));

  expect(await overflows(page, '[data-item]')).toEqual([]);
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
});

test('approval and question cards wrap a 120-character unbroken token inside the card at 390 px', async ({ page, request }) => {
  await openSession(page, request, 'ses_fake_3');
  await expect(page.getByRole('heading', { name: 'Sketch the README' })).toBeVisible();
  await request.post('/test/request', {
    data: { sessionId: 'ses_fake_3', request: { kind: 'command', command: TOKEN, cwd: `/${TOKEN}`, reason: TOKEN, availableDecisions: ['accept', 'decline'] } },
  });
  await request.post('/test/request', {
    data: {
      sessionId: 'ses_fake_3',
      request: {
        kind: 'fileChange',
        reason: TOKEN,
        availableDecisions: ['accept', 'decline'],
        changes: [{ path: TOKEN, kind: 'add', diff: `@@ -0,0 +1 @@\n+${TOKEN}\n` }],
      },
    },
  });
  for (const isBlocking of [false, true]) {
    await request.post('/test/request', {
      data: {
        sessionId: 'ses_fake_3',
        request: {
          kind: 'input',
          isBlocking,
          questions: [
            {
              id: `q_${isBlocking}`,
              header: TOKEN,
              question: TOKEN,
              options: [{ label: TOKEN, description: TOKEN }],
              multiSelect: false,
              isOther: true,
              isSecret: false,
            },
          ],
        },
      },
    });
  }

  await expect(page.locator('.request-card.approval')).toHaveCount(2);
  await expect(page.locator('.request-card.question')).toHaveCount(2);
  await expect(page.locator('.request-card.question.blocking')).toHaveCount(1);
  await expect(page.locator('.request-card.approval').first()).toContainText(TOKEN.slice(0, 40));

  expect(await overflows(page, '.request-card')).toEqual([]);
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
});
