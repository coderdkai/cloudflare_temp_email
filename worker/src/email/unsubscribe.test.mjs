import assert from 'node:assert/strict';
import test from 'node:test';

import { extractUnsubscribeTarget } from './unsubscribe.ts';

// 用户持仓的 OpenAI 营销邮件里的真实退订链接形态
const OPENAI_BODY_URL =
	'https://r.openai.com/asm/unsubscribe/?user_id=108370056&data=8_k4_wasMFbDyL_oJxB_gfqhCN9wOJQGgQ0hYVhFloRoMDAwdTAwMGE';

test('extractUnsubscribeTarget prefers the https header URL and reports one-click', () => {
	const target = extractUnsubscribeTarget([
		{ key: 'List-Unsubscribe', value: '<mailto:unsub@example.com>, <https://example.com/u/1>' },
		{ key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
	]);
	assert.deepEqual(target, {
		url: 'https://example.com/u/1',
		mailto: 'mailto:unsub@example.com',
		oneClick: true,
	});
});

test('extractUnsubscribeTarget tolerates folded and unbracketed header values', () => {
	const target = extractUnsubscribeTarget([
		{ key: 'list-unsubscribe', value: '\n <http://example.com/u/2>,\n http://example.com/u/3' },
	]);
	assert.equal(target?.url, 'http://example.com/u/2');
	assert.equal(target?.oneClick, false);
});

test('extractUnsubscribeTarget falls back to the body link before a mailto-only header', () => {
	const html = `<p>You can <a href="${OPENAI_BODY_URL.replace(/&/g, '&amp;')}">click here</a> to unsubscribe.</p>`;
	const target = extractUnsubscribeTarget(
		[{ key: 'List-Unsubscribe', value: '<mailto:unsubscribe@openai.com>' }],
		html,
	);
	assert.equal(target?.url, OPENAI_BODY_URL);
	assert.equal(target?.oneClick, false);
});

test('extractUnsubscribeTarget matches a body anchor by its label', () => {
	const html = '<a href="https://example.com/preferences/9f3">Unsubscribe from these emails</a>';
	assert.equal(extractUnsubscribeTarget([], html)?.url, 'https://example.com/preferences/9f3');
});

test('extractUnsubscribeTarget scans plain text for a URL near the keyword', () => {
	const text = 'If you no longer want these emails, unsubscribe here: https://example.com/u/abc123 .';
	assert.equal(extractUnsubscribeTarget([], '', text)?.url, 'https://example.com/u/abc123');
	assert.equal(extractUnsubscribeTarget([], '', 'See our privacy policy: https://example.com/legal'), null);
});

test('extractUnsubscribeTarget returns mailto when it is the only option', () => {
	assert.deepEqual(
		extractUnsubscribeTarget([{ key: 'List-Unsubscribe', value: '<mailto:unsub@example.com?subject=unsubscribe>' }]),
		{ mailto: 'mailto:unsub@example.com?subject=unsubscribe', oneClick: false },
	);
});

test('extractUnsubscribeTarget ignores transactional mail without any unsubscribe hint', () => {
	assert.equal(
		extractUnsubscribeTarget(
			[{ key: 'Subject', value: 'Your verification code' }],
			'<p>Your code is <b>123456</b></p>',
			'Your code is 123456',
		),
		null,
	);
	assert.equal(extractUnsubscribeTarget(undefined, undefined, undefined), null);
});
