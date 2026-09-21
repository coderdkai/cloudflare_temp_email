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
import { recordMailAuditLog, resolveTargetForwardAddresses } from './audit_log';

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

	// check if unknown address mail
	try {
		const emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
			{ env: env } as Context<HonoCustomType>,
			CONSTANTS.EMAIL_RULE_SETTINGS_KEY,
		);
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

	// resolve target forward addresses early for audit logging
	const targetForwardAddresses = await resolveTargetForwardAddresses(message.from, toAddress, env);
	let auditAction: 'FORWARDED' | 'DEDUP_SKIPPED' | 'TRANSACTION_FORWARD' = 'FORWARDED';
	let auditFingerprint: string | null = null;
	const parsedEmailForAudit = await commonParseMail(parsedEmailContext);

	// marketing email detection and deduplication
	if (env.KV && getBooleanValue(env.ENABLE_MARKETING_DEDUP)) {
		try {
			const isMarketing = isMarketingEmailByHeaders(parsedEmailForAudit?.headers, parsedEmailForAudit?.subject);
			if (isMarketing) {
				const bodyContent = parsedEmailForAudit?.text || extractTextFromHtml(parsedEmailForAudit?.html);
				const fingerprint = await computeMarketingFingerprint(
					message.from,
					parsedEmailForAudit?.subject,
					bodyContent,
					parsedEmailForAudit?.headers,
				);
				auditFingerprint = fingerprint;
				const kvKey = `mkt_hash:${fingerprint}`;
				const existing = await env.KV.get(kvKey);
				if (existing) {
					console.log(`Duplicate marketing email detected from ${message.from} to ${toAddress}, skip storing and forwarding.`);
					await recordMailAuditLog(env, {
						message_id,
						source: message.from,
						address: toAddress,
						subject: parsedEmailForAudit?.subject || null,
						action: 'DEDUP_SKIPPED',
						forwarded_to: targetForwardAddresses,
						fingerprint,
						reason: 'Duplicate marketing email hash hit in KV',
						created_at: createdAtIso,
					});
					return;
				}
				auditAction = 'FORWARDED';
				const ttl = Number(env.MARKETING_DEDUP_TTL) || 604800;
				await env.KV.put(kvKey, '1', { expirationTtl: ttl });
			} else {
				auditAction = 'TRANSACTION_FORWARD';
			}
		} catch (error) {
			console.error('marketing dedup error, proceeding normally', error);
		}
	} else {
		auditAction = 'FORWARDED';
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

	// record audit log for forwarded email (either first marketing or transactional)
	await recordMailAuditLog(env, {
		message_id,
		source: message.from,
		address: toAddress,
		subject: parsedEmailForAudit?.subject || null,
		action: auditAction,
		forwarded_to: targetForwardAddresses,
		fingerprint: auditFingerprint,
		reason: auditAction === 'TRANSACTION_FORWARD' ? 'Transactional mail forwarded' : 'First marketing mail forwarded',
		created_at: createdAtIso,
	});

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
