import assert from 'node:assert/strict';
import test from 'node:test';

import {
	isTransactionalEmail,
	isMarketingEmailByHeaders,
	normalizeBodyForFingerprint,
	computeMarketingFingerprint,
	getBaseDomain,
	extractEffectiveSenderDomain,
	extractTextFromHtml,
} from './marketing.ts';

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

test('isMarketingEmailByHeaders identifies various marketing headers including SendGrid', () => {
	assert.equal(isMarketingEmailByHeaders([{ key: 'List-Unsubscribe', value: '<mailto:unsub@example.com>' }]), true);
	assert.equal(isMarketingEmailByHeaders([{ key: 'Precedence', value: 'bulk' }]), true);
	assert.equal(isMarketingEmailByHeaders([{ key: 'Feedback-ID', value: 'campaign123:esp' }]), true);
	assert.equal(isMarketingEmailByHeaders([{ key: 'X-SG-ID', value: 'some-sendgrid-id' }]), true);
	assert.equal(isMarketingEmailByHeaders([{ key: 'X-Entity-ID', value: 'u001.xxx' }]), true);

	assert.equal(
		isMarketingEmailByHeaders([
			{ key: 'From', value: 'alice@example.com' },
			{ key: 'Subject', value: 'Hello friend' },
		]),
		false,
	);
});

test('getBaseDomain extracts organization primary domain', () => {
	assert.equal(getBaseDomain('em6623.email.openai.com'), 'openai.com');
	assert.equal(getBaseDomain('outbound.qs.icloud.com'), 'icloud.com');
	assert.equal(getBaseDomain('openai.com'), 'openai.com');
	assert.equal(getBaseDomain('test.gov.cn'), 'test.gov.cn');
	assert.equal(getBaseDomain('sub.mail.co.uk'), 'mail.co.uk');
});

test('extractEffectiveSenderDomain recovers original sender from Apple HME and headers', () => {
	const directEnvelope = 'bounces+108-test=410883.xyz@em6623.email.openai.com';
	assert.equal(extractEffectiveSenderDomain(directEnvelope), 'openai.com');

	const appleHeaders = [
		{
			key: 'X-ICLOUD-HME',
			value: 'p=tenants31.heir@icloud.com; d=; f=apple-coderdkai@410883.xyz; r=to; s=noreply@email.openai.com',
		},
		{
			key: 'From',
			value: 'ChatGPT <noreply_at_email_openai_com_4r494ygjwv8829_f6c4bf89@icloud.com>',
		},
	];
	const appleEnvelope = 'postmaster@outbound.qs.icloud.com';
	assert.equal(extractEffectiveSenderDomain(appleEnvelope, appleHeaders), 'openai.com');
});

test('extractTextFromHtml strips tags and extracts clean text', () => {
	const html = `
		<html>
			<head><style>.btn { color: red; }</style></head>
			<body>
				<h1>Welcome to OpenAI!</h1>
				<p>Look what you can do now with our new model.</p>
				<script>console.log("secret");</script>
			</body>
		</html>
	`;
	const text = extractTextFromHtml(html);
	assert.equal(text.includes('Welcome to OpenAI!'), true);
	assert.equal(text.includes('Look what you can do now'), true);
	assert.equal(text.includes('color: red'), false);
	assert.equal(text.includes('console.log'), false);
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

test('computeMarketingFingerprint produces identical hash across direct recipient and Apple HME forwarded recipient', async () => {
	const subject = 'Look what you can do now';
	const body = 'Welcome to the new release! Check out everything you can build.';

	// 1. Direct recipient
	const directFrom = 'bounces+108370056-b1f4-gpt-free-0227-k3t4kg=410883.xyz@em6623.email.openai.com';
	const directHeaders = [
		{ key: 'List-Unsubscribe', value: '<https://r.openai.com/unsub>' },
		{ key: 'From', value: 'ChatGPT <noreply@email.openai.com>' },
	];

	// 2. Apple Hide My Email forwarded recipient
	const appleEnvelopeFrom = 'postmaster@outbound.qs.icloud.com';
	const appleHeaders = [
		{ key: 'X-SG-ID', value: 'sg-token-xyz' },
		{ key: 'X-Entity-ID', value: 'u001.fuLTjbbFNnHmPBmC2XyIBw==' },
		{
			key: 'X-ICLOUD-HME',
			value: 'p=tenants31.heir@icloud.com; d=; f=apple-coderdkai@410883.xyz; r=to; s=noreply@email.openai.com',
		},
		{ key: 'From', value: 'ChatGPT <noreply_at_email_openai_com_4r494ygjwv8829_f6c4bf89@icloud.com>' },
	];

	// Both should be recognized as marketing emails
	assert.equal(isMarketingEmailByHeaders(directHeaders, subject), true);
	assert.equal(isMarketingEmailByHeaders(appleHeaders, subject), true);

	// Both should yield the exact same fingerprint
	const hashDirect = await computeMarketingFingerprint(directFrom, subject, body, directHeaders);
	const hashApple = await computeMarketingFingerprint(appleEnvelopeFrom, subject, body, appleHeaders);

	assert.equal(hashDirect.length, 64);
	assert.equal(hashApple, hashDirect);
});
