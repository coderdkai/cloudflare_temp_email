import assert from 'node:assert/strict';
import test from 'node:test';

import { isTransactionalEmail, isMarketingEmailByHeaders, normalizeBodyForFingerprint, computeMarketingFingerprint } from './marketing.ts';

test('isTransactionalEmail returns true for verification codes and notices', () => {
	assert.equal(isTransactionalEmail('Your Telegram Code - 287486'), true);
	assert.equal(isTransactionalEmail('Your verification code is 123456'), true);
	assert.equal(isTransactionalEmail('【某某平台】您的验证码是 8899'), true);
	assert.equal(isTransactionalEmail("We couldn't process your payment for team My Team"), true);
	assert.equal(isTransactionalEmail('Your 2026-08 invoice is available'), true);
	assert.equal(isTransactionalEmail('Try Grok Bot free for 3 days'), false);
});

test('isMarketingEmailByHeaders respects transactional whitelist over marketing headers', () => {
	const headers = [
		{ key: 'List-Unsubscribe', value: '<https://example.com/unsub>' },
		{ key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
	];
	// With transactional subject, should NOT be marked as marketing
	assert.equal(isMarketingEmailByHeaders(headers, 'Your verification code: 654321'), false);
	// With promotional subject, SHOULD be marked as marketing
	assert.equal(isMarketingEmailByHeaders(headers, 'Try Grok Bot free for 3 days'), true);
});

test('isMarketingEmailByHeaders identifies various marketing headers', () => {
	assert.equal(isMarketingEmailByHeaders([{ key: 'List-Unsubscribe', value: '<mailto:unsub@example.com>' }]), true);

	assert.equal(isMarketingEmailByHeaders([{ key: 'Precedence', value: 'bulk' }]), true);

	assert.equal(isMarketingEmailByHeaders([{ key: 'Feedback-ID', value: 'campaign123:esp' }]), true);

	assert.equal(
		isMarketingEmailByHeaders([
			{ key: 'From', value: 'alice@example.com' },
			{ key: 'Subject', value: 'Hello friend' },
		]),
		false,
	);
});

test('normalizeBodyForFingerprint removes URLs, emails, and extra whitespaces', () => {
	const rawBody = `
        Hello there!
        Visit https://email.example.com/unsub?token=user123_abc for settings.
        Contact support@example.com if you have questions.
        Enjoy the promo!
    `;
	const normalized = normalizeBodyForFingerprint(rawBody);
	assert.equal(normalized.includes('user123_abc'), false);
	assert.equal(normalized.includes('support@example.com'), false);
	assert.equal(normalized.includes('hello there!'), true);
	assert.equal(normalized.includes('enjoy the promo!'), true);
});

test('computeMarketingFingerprint produces identical hash for same promotional mail across recipients', async () => {
	const from = 'updates@email.grok.com';
	const subject = "Ask Grok what's happening now";

	// Recipient A body with user-specific unsubscribe URL and email
	const bodyA = `
        Ask Grok what's happening now.
        Click here to explore new capabilities!
        Unsubscribe: https://04.emailinboundprocessing.com/enc_user/list_unsubscribe?d=token_user_a
        Sent to userA@temp.com
    `;

	// Recipient B body with different user-specific unsubscribe URL and email
	const bodyB = `
        Ask Grok what's happening now.
        Click here to explore new capabilities!
        Unsubscribe: https://04.emailinboundprocessing.com/enc_user/list_unsubscribe?d=token_user_b
        Sent to userB@temp.com
    `;

	const hashA = await computeMarketingFingerprint(from, subject, bodyA);
	const hashB = await computeMarketingFingerprint(from, subject, bodyB);

	assert.equal(hashA.length, 64);
	assert.equal(hashA, hashB);
});
