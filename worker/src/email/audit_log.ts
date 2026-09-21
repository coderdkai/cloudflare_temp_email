import { Context } from 'hono';
import { getEnvStringList, getJsonObjectValue, getJsonSetting, getMailDomain, isDomainOrSubdomain, normalizeDomain } from '../utils';
import { EmailRuleSettings } from '../models';
import { CONSTANTS } from '../constants';

export type MailAuditAction =
	'FORWARDED' | 'DEDUP_SKIPPED' | 'JUNK_REJECTED' | 'TRANSACTION_FORWARD' | 'UNKNOWN_ADDRESS_REJECTED' | 'BLOCKED_SENDER_REJECTED';

export type MailAuditLogEntry = {
	message_id: string | null;
	source: string;
	address: string;
	subject: string | null;
	action: MailAuditAction;
	forwarded_to: string[];
	fingerprint?: string | null;
	reason?: string | null;
	created_at: string;
};

// 正则表达式最大长度限制，防止 ReDoS 攻击
const MAX_REGEX_PATTERN_LENGTH = 200;

function safeRegexTest(pattern: string, input: string): boolean {
	try {
		if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
			return false;
		}
		const regex = new RegExp(pattern, 'i');
		return regex.test(input);
	} catch {
		return false;
	}
}

function matchSourcePatterns(
	from: string,
	sourcePatterns: string[] | undefined | null,
	sourceMatchMode: 'any' | 'all' | undefined,
): boolean {
	if (!sourcePatterns || sourcePatterns.length === 0) {
		return true;
	}
	const matchMode = sourceMatchMode || 'any';
	if (matchMode === 'all') {
		return sourcePatterns.every((pattern) => safeRegexTest(pattern, from));
	} else {
		return sourcePatterns.some((pattern) => safeRegexTest(pattern, from));
	}
}

/**
 * 根据系统环境配置预先解析目标收件临时邮箱命中的所有转发地址
 */
export async function resolveTargetForwardAddresses(from: string, to: string, env: Bindings): Promise<string[]> {
	const targets = new Set<string>();

	// 1. 全局转发列表
	const forwardAddressList = getEnvStringList(env.FORWARD_ADDRESS_LIST);
	for (const addr of forwardAddressList) {
		if (addr) targets.add(addr);
	}

	// 2. 规则转发列表
	try {
		const subdomainForwardAddressList = getJsonObjectValue<SubdomainForwardAddressList[]>(env.SUBDOMAIN_FORWARD_ADDRESS_LIST) || [];
		const emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
			{ env: env } as Context<HonoCustomType>,
			CONSTANTS.EMAIL_RULE_SETTINGS_KEY,
		);
		const allRules = [...(subdomainForwardAddressList || []), ...(emailRuleSettings?.emailForwardingList || [])];

		const messageDomain = getMailDomain(to);
		for (const rule of allRules) {
			if (!matchSourcePatterns(from, rule.sourcePatterns, rule.sourceMatchMode)) {
				continue;
			}
			if (rule.domains && rule.domains.length > 0) {
				const normalizedDomains = rule.domains.map(normalizeDomain);
				if (normalizedDomains.some((d) => d.length === 0)) {
					if (rule.forward) targets.add(rule.forward);
					continue;
				}
				for (const normalizedDomain of normalizedDomains) {
					if (isDomainOrSubdomain(messageDomain, normalizedDomain) && rule.forward) {
						targets.add(rule.forward);
					}
				}
			} else {
				if (rule.forward) targets.add(rule.forward);
			}
		}
	} catch (e) {
		console.error('resolveTargetForwardAddresses error:', e);
	}

	return Array.from(targets);
}

/**
 * 实时记录邮件流转审计日志到 KV 中（高吞吐、0 D1 写入开销）
 * Key 格式: mail_audit_log:<timestamp_ms>:<random_suffix>
 */
export async function recordMailAuditLog(env: Bindings, entry: MailAuditLogEntry): Promise<void> {
	if (!env.KV) return;
	try {
		const now = Date.now();
		const rand = Math.random().toString(36).substring(2, 8);
		const kvKey = `mail_audit_log:${now}:${rand}`;
		// KV 暂存保留 7 天，等待 Cron 定时任务批量落库 D1
		await env.KV.put(kvKey, JSON.stringify(entry), { expirationTtl: 604800 });
	} catch (error) {
		console.error('recordMailAuditLog error:', error);
	}
}
