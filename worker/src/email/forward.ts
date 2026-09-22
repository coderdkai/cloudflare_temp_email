import { Context } from 'hono';

import { getEnvStringList, getJsonObjectValue, getJsonSetting, getMailDomain, isDomainOrSubdomain, normalizeDomain } from '../utils';
import { EmailRuleSettings } from '../models';
import { CONSTANTS } from '../constants';

// 正则表达式最大长度限制，防止 ReDoS 攻击
const MAX_REGEX_PATTERN_LENGTH = 200;

/**
 * 安全地测试单个正则表达式
 */
function safeRegexTest(pattern: string, input: string): boolean {
	try {
		// 限制正则复杂度：最大长度限制
		if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
			console.warn('source pattern too long, skipped:', pattern.substring(0, 50) + '...');
			return false;
		}
		const regex = new RegExp(pattern, 'i');
		return regex.test(input);
	} catch (regexError) {
		console.error('regex test error for pattern:', pattern, regexError);
		return false;
	}
}

/**
 * 检查来源地址是否匹配正则规则
 */
function matchSourcePatterns(
	from: string,
	sourcePatterns: string[] | undefined | null,
	sourceMatchMode: 'any' | 'all' | undefined,
): boolean {
	if (!sourcePatterns || sourcePatterns.length === 0) {
		// 未配置来源正则，默认匹配
		return true;
	}

	const matchMode = sourceMatchMode || 'any';

	if (matchMode === 'all') {
		// 全部匹配模式：所有正则都必须匹配
		return sourcePatterns.every((pattern) => safeRegexTest(pattern, from));
	} else {
		// 任一匹配模式（默认）：任一正则匹配即可
		return sourcePatterns.some((pattern) => safeRegexTest(pattern, from));
	}
}

/**
 * 全局转发：转发到 FORWARD_ADDRESS_LIST 中的所有地址
 */
async function forwardToGlobalAddresses(message: ForwardableEmailMessage, env: Bindings): Promise<void> {
	try {
		const forwardAddressList = getEnvStringList(env.FORWARD_ADDRESS_LIST);
		for (const forwardAddress of forwardAddressList) {
			await message.forward(forwardAddress);
		}
	} catch (error) {
		console.error('forward email error', error);
	}
}

/**
 * 规则转发：根据域名和来源地址正则规则转发
 */
async function forwardByRules(message: ForwardableEmailMessage, env: Bindings): Promise<void> {
	try {
		// 获取环境变量配置
		const subdomainForwardAddressList = getJsonObjectValue<SubdomainForwardAddressList[]>(env.SUBDOMAIN_FORWARD_ADDRESS_LIST) || [];

		// 获取数据库配置
		const emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
			{ env: env } as Context<HonoCustomType>,
			CONSTANTS.EMAIL_RULE_SETTINGS_KEY,
		);

		// 合并两个配置，env 里的配置优先级更高
		const allRules = [...(subdomainForwardAddressList || []), ...(emailRuleSettings?.emailForwardingList || [])];

		const messageDomain = getMailDomain(message.to);
		for (const rule of allRules) {
			// 检查来源地址是否匹配正则
			if (!matchSourcePatterns(message.from, rule.sourcePatterns, rule.sourceMatchMode)) {
				continue;
			}

			// 检查目标地址是否匹配域名，并转发
			// 保持原始逻辑：每个匹配的 domain 都会触发一次转发
			if (rule.domains && rule.domains.length > 0) {
				const normalizedDomains = rule.domains.map(normalizeDomain);
				if (normalizedDomains.some((domain) => domain.length === 0)) {
					if (rule.forward) {
						await message.forward(rule.forward);
					}
					continue;
				}

				for (const normalizedDomain of normalizedDomains) {
					if (isDomainOrSubdomain(messageDomain, normalizedDomain) && rule.forward) {
						await message.forward(rule.forward);
					}
				}
			} else {
				// 域名为空，转发所有邮件
				if (rule.forward) {
					await message.forward(rule.forward);
				}
			}
		}
	} catch (error) {
		console.error('forward by rules error', error);
	}
}

/**
 * 检查当前收件地址是否处于创建后的“免转发/静默时间窗口”中
 */
async function isAddressInSilentForwardWindow(
	addressName: string,
	env: Bindings,
): Promise<{ inSilentWindow: boolean; silentMinutes?: number }> {
	if (!env.DB) return { inSilentWindow: false };
	try {
		const row = await env.DB.prepare(`SELECT created_at, source_meta FROM address WHERE name = ?`)
			.bind(addressName)
			.first<{ created_at: string; source_meta: string | null }>();

		if (!row || !row.source_meta) {
			return { inSilentWindow: false };
		}

		let silentMinutes = 0;
		try {
			const metaObj = JSON.parse(row.source_meta);
			if (metaObj && typeof metaObj.no_fwd_min === 'number') {
				silentMinutes = metaObj.no_fwd_min;
			}
		} catch {
			// source_meta 是普通字符串（如 'admin' 或 IP），非 json
			return { inSilentWindow: false };
		}

		if (silentMinutes <= 0) {
			return { inSilentWindow: false };
		}

		// 计算创建时间与当前时间的差值（按毫秒计算）
		const createdAtMs = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
		const nowMs = Date.now();
		const diffMinutes = (nowMs - createdAtMs) / (1000 * 60);

		if (diffMinutes < silentMinutes) {
			return { inSilentWindow: true, silentMinutes };
		}
	} catch (e) {
		console.error('isAddressInSilentForwardWindow check error:', e);
	}
	return { inSilentWindow: false };
}

/**
 * 执行所有转发逻辑
 */
async function forwardEmail(message: ForwardableEmailMessage, env: Bindings): Promise<void> {
	// 检查是否处于创建后的免转发节流时间窗口
	const { inSilentWindow, silentMinutes } = await isAddressInSilentForwardWindow(message.to, env);
	if (inSilentWindow) {
		console.log(`Address ${message.to} is in ${silentMinutes}m silent forward window, skip forwarding.`);
		return;
	}

	// 全局转发
	await forwardToGlobalAddresses(message, env);

	// 规则转发
	await forwardByRules(message, env);
}

export { forwardEmail, forwardToGlobalAddresses, forwardByRules, matchSourcePatterns, isAddressInSilentForwardWindow };
