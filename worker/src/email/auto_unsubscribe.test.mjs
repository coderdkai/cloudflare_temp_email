import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAutoUnsubscribeRequest } from './auto_unsubscribe.ts';

const OPENAI_URL =
	'https://r.openai.com/asm/unsubscribe/?user_id=108370056&data=8_k4_wasMFbDyL_oJxB_gfqhCN9wOJQGgQ0hYVhFloRoMDAwdTAwMGE';

test('resolveAutoUnsubscribeRequest accepts the sender-owned unsubscribe link', () => {
	const target = resolveAutoUnsubscribeRequest(
		'noreply@email.openai.com',
		[
			{ key: 'List-Unsubscribe', value: `<mailto:unsub@openai.com>, <${OPENAI_URL}>` },
			{ key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
		],
	);
	assert.deepEqual(target, { url: OPENAI_URL, oneClick: true });
});

test('resolveAutoUnsubscribeRequest rejects links on a third-party domain', () => {
	assert.equal(
		resolveAutoUnsubscribeRequest(
			'noreply@email.openai.com',
			[{ key: 'List-Unsubscribe', value: '<https://tracking.esp-example.com/unsub?u=1>' }],
		),
		null,
	);
});

test('resolveAutoUnsubscribeRequest rejects lookalike domains that only share a prefix', () => {
	assert.equal(
		resolveAutoUnsubscribeRequest(
			'noreply@email.openai.com',
			[{ key: 'List-Unsubscribe', value: '<https://openai.com.evil.example/unsub>' }],
		),
		null,
	);
});

test('resolveAutoUnsubscribeRequest rejects mailto-only targets', () => {
	assert.equal(
		resolveAutoUnsubscribeRequest('noreply@email.openai.com', [
			{ key: 'List-Unsubscribe', value: '<mailto:unsub@openai.com>' },
		]),
		null,
	);
});

test('resolveAutoUnsubscribeRequest uses the body link when headers are missing', () => {
	const html = `<p><a href="${OPENAI_URL.replace(/&/g, '&amp;')}">Unsubscribe</a></p>`;
	assert.deepEqual(
		resolveAutoUnsubscribeRequest('noreply@email.openai.com', [], html, ''),
		{ url: OPENAI_URL, oneClick: false },
	);
});

test('resolveAutoUnsubscribeRequest resolves the real sender behind an Apple HME forward', () => {
	const target = resolveAutoUnsubscribeRequest(
		'someone_at_openai_com_abc123@icloud.com',
		[
			{ key: 'From', value: 'ChatGPT <noreply_at_email_openai_com_abc123@icloud.com>' },
			{ key: 'List-Unsubscribe', value: `<${OPENAI_URL}>` },
		],
	);
	assert.equal(target?.url, OPENAI_URL);
});
