/**
 * 提取发件人邮箱的域名
 */
export function extractMailDomain(address: string | undefined | null): string {
	if (!address) return '';
	const atIndex = address.lastIndexOf('@');
	if (atIndex === -1) return address.trim().toLowerCase();
	return address
		.slice(atIndex + 1)
		.trim()
		.toLowerCase();
}

/**
 * 提取二级主域名（组织主域），例如 em6623.email.openai.com -> openai.com
 * 支持常见的二段后缀如 com.cn, co.uk, net.cn 等
 */
export function getBaseDomain(domain: string | undefined | null): string {
	if (!domain) return '';
	const cleanDomain = domain.trim().toLowerCase();
	const parts = cleanDomain.split('.').filter(Boolean);
	if (parts.length <= 2) return cleanDomain;

	const secondLevelTlds = new Set([
		'com.cn',
		'net.cn',
		'org.cn',
		'gov.cn',
		'edu.cn',
		'co.uk',
		'org.uk',
		'me.uk',
		'com.au',
		'net.au',
		'co.jp',
		'ne.jp',
		'co.kr',
		'com.tw',
		'com.hk',
	]);

	const lastTwo = parts.slice(-2).join('.');
	if (secondLevelTlds.has(lastTwo)) {
		if (parts.length >= 3) {
			return parts.slice(-3).join('.');
		}
		return cleanDomain;
	}

	return parts.slice(-2).join('.');
}

/**
 * 从邮件标头中提取真实的原始发件人域名（支持 Apple 隐私转发与常见邮件头溯源）
 */
export function extractEffectiveSenderDomain(
	envelopeFrom: string | undefined | null,
	headers?: Record<string, string>[] | undefined | null,
): string {
	if (headers && Array.isArray(headers)) {
		// 1. Apple Hide My Email 转发头：X-ICLOUD-HME: ... s=noreply@email.openai.com
		const hmeHeader = headers.find((h) => h.key && h.key.trim().toLowerCase() === 'x-icloud-hme');
		if (hmeHeader && hmeHeader.value) {
			const senderMatch = hmeHeader.value.match(/\bs=([^\s;]+)/i);
			if (senderMatch && senderMatch[1]) {
				const sourceDomain = extractMailDomain(senderMatch[1]);
				if (sourceDomain) {
					return getBaseDomain(sourceDomain);
				}
			}
		}

		// 2. 检查外层 From 标头，如果是 Apple 混淆地址 noreply_at_domain_com_xxx@icloud.com
		const fromHeader = headers.find((h) => h.key && h.key.trim().toLowerCase() === 'from');
		if (fromHeader && fromHeader.value) {
			const appleObfuscatedMatch = fromHeader.value.match(/_at_([a-zA-Z0-9_-]+(?:_[a-zA-Z0-9_-]+)+)_[a-zA-Z0-9]+@/i);
			if (appleObfuscatedMatch && appleObfuscatedMatch[1]) {
				const decodedDomain = appleObfuscatedMatch[1].replace(/_/g, '.');
				if (decodedDomain.includes('.')) {
					return getBaseDomain(decodedDomain);
				}
			}
		}
	}

	// 3. 回退至 envelopeFrom，并规范化为主域名
	const domain = extractMailDomain(envelopeFrom);
	return getBaseDomain(domain);
}

// 事务性/验证类邮件主题关键词（白名单保护：直接放行，避免误伤验证码或账单通知）
const TRANSACTIONAL_SUBJECT_KEYWORDS: readonly string[] = [
	'verification code',
	'verify your',
	'verify',
	'verification',
	'security code',
	'auth code',
	'confirm your',
	'confirmation code',
	'confirm account',
	'one-time password',
	'otp',
	'passcode',
	'your code',
	'code -',
	'code challenge',
	'login code',
	'access code',
	'password reset',
	'reset your password',
	'two-factor',
	'2fa',
	'mfa',
	'invoice',
	'payment',
	'receipt',
	'account suspended',
	'account termination',
	'account security',
	'account alert',
	'验证码',
	'验证您的',
	'邮箱验证',
	'身份验证',
	'登录验证',
	'双重验证',
	'两步验证',
	'双重认证',
	'安全验证',
	'验证',
	'校验码',
	'校验',
	'安全码',
	'授权码',
	'动态码',
	'动态密码',
	'动态口令',
	'临时密码',
	'安全代码',
	'激活码',
	'激活您的',
	'激活账号',
	'确认您的',
	'确认账号',
	'重置密码',
	'修改密码',
	'找回密码',
	'账单',
	'支付凭证',
	'扣费',
	'扣款',
	'订单确认',
];

// 标准营销邮件请求头名称
const MARKETING_HEADER_NAMES: readonly string[] = [
	'list-unsubscribe',
	'list-unsubscribe-post',
	'feedback-id',
	'x-campaign',
	'x-campaign-id',
	'x-mc-user',
	'x-mailgun-campaign-id',
	'x-mailgun-tag',
	'x-sendgrid-eid',
	'x-sg-eid',
	'x-sg-id',
	'x-entity-id',
	'x-postmark-tag',
	'x-ses-outgoing',
];

/**
 * 判断是否包含事务/验证类高优先级的关键词（白名单）
 */
export function isTransactionalEmail(subject: string | undefined | null, customKeywords?: string[] | undefined | null): boolean {
	if (!subject) return false;
	const lowerSubj = subject.toLowerCase();
	if (TRANSACTIONAL_SUBJECT_KEYWORDS.some((kw) => lowerSubj.includes(kw))) {
		return true;
	}
	if (customKeywords && Array.isArray(customKeywords)) {
		return customKeywords.some((kw) => {
			const clean = kw?.trim()?.toLowerCase();
			return clean && clean.length > 0 && lowerSubj.includes(clean);
		});
	}
	return false;
}

/**
 * 判断发件人或 Apple 混淆转发原始发件人是否命中白名单
 */
export function isWhitelistedSender(
	from: string | undefined | null,
	headers?: Record<string, string>[] | undefined | null,
	senderWhitelist?: string[] | undefined | null,
): boolean {
	if (!senderWhitelist || !Array.isArray(senderWhitelist) || senderWhitelist.length === 0) {
		return false;
	}
	const candidateSenders: string[] = [];
	if (from) candidateSenders.push(from.trim().toLowerCase());
	if (headers && Array.isArray(headers)) {
		const hme = headers.find((h) => h.key && h.key.trim().toLowerCase() === 'x-icloud-hme');
		if (hme && hme.value) {
			const sMatch = hme.value.match(/\bs=([^\s;]+)/i);
			if (sMatch && sMatch[1]) candidateSenders.push(sMatch[1].trim().toLowerCase());
		}
		const fromH = headers.find((h) => h.key && h.key.trim().toLowerCase() === 'from');
		if (fromH && fromH.value) candidateSenders.push(fromH.value.trim().toLowerCase());
	}

	return senderWhitelist.some((rule) => {
		const r = rule?.trim()?.toLowerCase();
		if (!r) return false;
		return candidateSenders.some((sender) => sender.includes(r));
	});
}

/**
 * 依据邮件头判断是否为商业/营销群发邮件
 */
export function isMarketingEmailByHeaders(
	headers: Record<string, string>[] | undefined | null,
	subject?: string | null,
	customSubjectKeywords?: string[] | undefined | null,
	from?: string | null,
	senderWhitelist?: string[] | undefined | null,
): boolean {
	// 1. 白名单发件人保护：若发件人或原始发件人命中白名单，绝不判定为营销邮件
	if (isWhitelistedSender(from, headers, senderWhitelist)) {
		return false;
	}

	// 2. 白名单主题保护：若标题明确为验证码或重要事务通知（或命中自定义白名单关键词），绝不判定为营销邮件
	if (isTransactionalEmail(subject, customSubjectKeywords)) {
		return false;
	}

	if (!headers || !Array.isArray(headers)) {
		return false;
	}

	for (const header of headers) {
		if (!header.key || !header.value) continue;
		const key = header.key.trim().toLowerCase();
		const value = header.value.trim().toLowerCase();

		// 命中标准营销/退订等标头
		if (MARKETING_HEADER_NAMES.includes(key)) {
			return true;
		}

		// 批量/列表优先级标头
		if (key === 'precedence' && (value.includes('bulk') || value.includes('list'))) {
			return true;
		}

		// 自动投递的营销摘要等
		if (key === 'x-auto-response-suppress' && value.includes('all')) {
			return true;
		}
	}

	return false;
}

/**
 * 从 HTML 中粗提取纯文本作为正文兜底
 */
export function extractTextFromHtml(html: string | undefined | null): string {
	if (!html) return '';
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#39;/g, "'")
		.replace(/&quot;/gi, '"');
}

/**
 * 规范化邮件正文片段，剔除收件人特定参数、动态退订链接等噪声，保留主体文本
 * 取前 200 字符即可稳定对齐同批次营销推广文案的主引言/副标题，避免末尾个性化模块差异
 */
export function normalizeBodyForFingerprint(bodyText: string): string {
	if (!bodyText) return '';

	return (
		bodyText
			// 移除 URL 链接以消除个性化 token 与 tracking 参数的影响
			.replace(/https?:\/\/[^\s<>"')]+/gi, ' ')
			// 移除邮箱地址
			.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ')
			// 移除连续空白与换行
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 200)
			.toLowerCase()
	);
}

/**
 * 生成营销邮件内容去重指纹 Hash (SHA-256)
 */
export async function computeMarketingFingerprint(
	from: string,
	subject: string | undefined | null,
	bodyText: string | undefined | null,
	headers?: Record<string, string>[] | undefined | null,
): Promise<string> {
	const senderDomain = extractEffectiveSenderDomain(from, headers);
	const normalizedSubject = (subject || '').trim().toLowerCase().replace(/\s+/g, ' ');
	const normalizedBody = normalizeBodyForFingerprint(bodyText || '');

	const payload = `${senderDomain}|${normalizedSubject}|${normalizedBody}`;
	const encoder = new TextEncoder();
	const data = encoder.encode(payload);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
