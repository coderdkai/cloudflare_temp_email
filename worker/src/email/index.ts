import { Context } from 'hono';

import { getBooleanValue, getJsonSetting, normalizeAddressDomain } from '../utils';
import { sendMailToTelegram } from '../telegram_api';
import { auto_reply } from './auto_reply';
import { isBlocked } from './black_list';
import { triggerWebhook, triggerAnotherWorker, commonParseMail } from '../common';
import { check_if_junk_mail } from './check_junk';
import { remove_attachment_if_need } from './check_attachment';
import { extractEmailInfo } from './ai_extract';
import { forwardEmail } from './forward';
import { EmailRuleSettings } from '../models';
import { CONSTANTS } from '../constants';
import { storeRawMail } from './storage';
import { isMarketingEmailByHeaders, computeMarketingFingerprint, extractTextFromHtml } from './marketing';
import { autoUnsubscribe } from './auto_unsubscribe';
import { recordMailAuditLog } from './audit_log';

async function email(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext) {
	const toAddress = normalizeAddressDomain(message.to);
	const message_id = message.headers.get('Message-ID');
	const createdAtIso = new Date().toISOString();

	if (await isBlocked(message.from, env)) {
		message.setReject('Reject from address');
		console.log(`Reject message from ${message.from} to ${toAddress}`);
		await recordMailAuditLog(env, {
			message_id,
			source: message.from,
			address: toAddress,
			subject: null,
			action: 'BLOCKED_SENDER_REJECTED',
			forwarded_to: [],
			reason: 'Sender in block list',
			created_at: createdAtIso,
		});
		return;
	}
	const rawEmail = await new Response(message.raw).text();
	const parsedEmailContext: ParsedEmailContext = {
		rawEmail: rawEmail,
	};

	// check if junk mail
	try {
		const is_junk = await check_if_junk_mail(env, toAddress, parsedEmailContext, message.headers.get('Message-ID'));
		if (is_junk) {
			message.setReject('Junk mail');
			console.log(`Junk mail from ${message.from} to ${toAddress}`);
			const parsed = await commonParseMail(parsedEmailContext);
			await recordMailAuditLog(env, {
				message_id,
				source: message.from,
				address: toAddress,
				subject: parsed?.subject || null,
				action: 'JUNK_REJECTED',
				forwarded_to: [],
				reason: 'Failed SPF/DKIM/DMARC check',
				created_at: createdAtIso,
			});
			return;
		}
	} catch (error) {
		console.error('check junk mail error', error);
	}

	// load email rules settings
	let emailRuleSettings: EmailRuleSettings | null = null;
	try {
		emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
			{ env: env } as Context<HonoCustomType>,
			CONSTANTS.EMAIL_RULE_SETTINGS_KEY,
		);
	} catch (error) {
		console.error('get emailRuleSettings error', error);
	}

	// check if unknown address mail
	try {
		if (emailRuleSettings?.blockReceiveUnknowAddressEmail) {
			const db_address_id = await env.DB.prepare(`SELECT id FROM address where name = ? `).bind(toAddress).first('id');
			if (!db_address_id) {
				message.setReject('Unknown address');
				console.log(`Unknown address mail from ${message.from} to ${toAddress}`);
				const parsed = await commonParseMail(parsedEmailContext);
				await recordMailAuditLog(env, {
					message_id,
					source: message.from,
					address: toAddress,
					subject: parsed?.subject || null,
					action: 'UNKNOWN_ADDRESS_REJECTED',
					forwarded_to: [],
					reason: 'Recipient address not found in database',
					created_at: createdAtIso,
				});
				return;
			}
		}
	} catch (error) {
		console.error('check unknown address mail error', error);
	}

	// remove attachment if configured or size > 2MB
	try {
		await remove_attachment_if_need(env, parsedEmailContext, message.from, toAddress, message.rawSize);
	} catch (error) {
		console.error('remove attachment error', error);
	}

	const parsedEmailForDedup = await commonParseMail(parsedEmailContext);

	// marketing email detection and deduplication
	const autoUnsubscribeEnabled = getBooleanValue(env.ENABLE_MARKETING_AUTO_UNSUBSCRIBE);
	const dedupEnabled = !!(env.KV && getBooleanValue(env.ENABLE_MARKETING_DEDUP));
	if (autoUnsubscribeEnabled || dedupEnabled) {
		try {
			const isMarketing = isMarketingEmailByHeaders(
				parsedEmailForDedup?.headers,
				parsedEmailForDedup?.subject,
				emailRuleSettings?.subjectKeywordsWhitelist,
				message.from,
				emailRuleSettings?.senderWhitelist,
			);
			if (isMarketing) {
				// 去重只会保留首封，退订链接又是按收件人定制的，必须在提前 return 之前让每个地址各自退订；
				// 用 waitUntil 避免阻塞入库与转发
				if (autoUnsubscribeEnabled) {
					ctx.waitUntil(autoUnsubscribe(
						message.from,
						parsedEmailForDedup?.headers,
						parsedEmailForDedup?.html,
						parsedEmailForDedup?.text,
					));
				}
				if (dedupEnabled) {
					const bodyContent = parsedEmailForDedup?.text || extractTextFromHtml(parsedEmailForDedup?.html);
					const fingerprint = await computeMarketingFingerprint(
						message.from,
						parsedEmailForDedup?.subject,
						bodyContent,
						parsedEmailForDedup?.headers,
					);
					const kvKey = `mkt_hash:${fingerprint}`;
					const existing = await env.KV.get(kvKey);
					if (existing) {
						console.log(`Duplicate marketing email detected from ${message.from} to ${toAddress}, skip storing and forwarding.`);
						return;
					}
					const ttl = Number(env.MARKETING_DEDUP_TTL) || 604800;
					await env.KV.put(kvKey, '1', { expirationTtl: ttl });
				}
			}
		} catch (error) {
			console.error('marketing dedup error, proceeding normally', error);
		}
	}
	// save email
	const storedMailId = await storeRawMail(env, message.from, toAddress, message_id, parsedEmailContext.rawEmail)
		.then(({ success, meta }) => {
			if (!success) {
				message.setReject(`Failed save message to ${toAddress}`);
				console.error(`Failed save message from ${message.from} to ${toAddress}`);
			}
			return success ? meta.last_row_id : undefined;
		})
		.catch((error) => {
			console.error('save email error', error);
			return undefined;
		});

	// forward email
	await forwardEmail(message, env);

	// AI email content extraction
	const aiExtractResult = await extractEmailInfo(parsedEmailContext, env, message_id, toAddress);

	// send email to telegram
	try {
		await sendMailToTelegram({ env: env } as Context<HonoCustomType>, toAddress, parsedEmailContext, message_id, aiExtractResult);
	} catch (error) {
		console.error('send mail to telegram error', error);
	}

	// send webhook
	try {
		await triggerWebhook({ env: env } as Context<HonoCustomType>, toAddress, parsedEmailContext, storedMailId, aiExtractResult);
	} catch (error) {
		console.error('send webhook error', error);
	}

	// trigger another worker
	try {
		const parsedEmail = await commonParseMail(parsedEmailContext);
		const parsedText = parsedEmail?.text ?? '';
		const rpcEmail: RPCEmailMessage = {
			from: message.from,
			to: toAddress,
			rawEmail: rawEmail,
			headers: message.headers,
		};
		await triggerAnotherWorker({ env: env } as Context<HonoCustomType>, rpcEmail, parsedText);
	} catch (error) {
		console.error('trigger another worker error', error);
	}

	// auto reply email
	await auto_reply(message, env, toAddress);
}

export { email };
