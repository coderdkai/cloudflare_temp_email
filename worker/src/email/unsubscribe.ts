/**
 * Unsubscribe target extraction.
 *
 * Resolves where and how a received email can be unsubscribed from:
 * 1. the standard `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 2369 / 8058)
 * 2. a fallback scan of the body for a link the sender itself labels as unsubscribe
 */

export type UnsubscribeTarget = {
	/** http(s) endpoint that performs the unsubscribe */
	url?: string;
	/** mailto: URI, only present when the sender offers email-based unsubscribe */
	mailto?: string;
	/** RFC 8058 one-click: POST `List-Unsubscribe=One-Click` to `url` instead of a plain GET */
	oneClick: boolean;
};

// 文案/正文上下文中的退订关键词（用于识别正文兜底链接）
const UNSUBSCRIBE_KEYWORDS: readonly string[] = [
	'unsubscribe',
	'un-subscribe',
	'opt-out',
	'opt out',
	'optout',
	'退订',
	'取消订阅',
	'取消訂閱',
	'配信停止',
	'abmelden',
	'desabonner',
	'darse de baja',
];

// URL 自身的退订特征（发件人常把链接文案写成 “click here” 之类）
const UNSUBSCRIBE_URL_RE =
	/unsubscrib|\/unsub(?:[/?#]|$)|\/opt-?out(?:[/?#]|$)|optout|退订|取消订阅|取消訂閱|配信停止|abmelden|desabonner|darse\+de\+baja/i;

const HTTP_URL_RE = /^https?:\/\//i;
const MAILTO_RE = /^mailto:/i;
const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const URL_SCAN_RE = /https?:\/\/[^\s<>"')\]\\]+/gi;
const CONTEXT_LOOKBEHIND = 40;

/**
 * `List-Unsubscribe` 允许一条头里带多个 `<...>` 条目，也可能被折行或被不规范的发件人写成裸地址
 */
const splitHeaderEntries = (value: string): string[] => {
	const bracketed: string[] = [];
	const rest = value.replace(/<([^>]+)>/g, (_match, inner: string) => {
		bracketed.push(inner.trim());
		return ',';
	});
	const loose = rest
		.split(',')
		.map(part => part.trim())
		.filter(part => part.includes(':'));
	return [...bracketed, ...loose].filter(Boolean);
};

/**
 * 正文兜底：先看 `<a href>` 锚点（链接文案或 URL 命中退订特征），再看纯文本里靠近退订关键词的 URL
 */
const findBodyUnsubscribeUrl = (html?: string | null, text?: string | null): string | undefined => {
	const candidates: { url: string; context: string }[] = [];

	if (html) {
		for (const match of html.matchAll(ANCHOR_RE)) {
			const href = (match[1] ?? match[2] ?? match[3] ?? '').replace(/&amp;/gi, '&');
			if (!HTTP_URL_RE.test(href)) continue;
			candidates.push({ url: href, context: (match[4] ?? '').replace(/<[^>]+>/g, ' ') });
		}
	}

	const plain = `${html ?? ''} ${text ?? ''}`.replace(/<[^>]+>/g, ' ');
	for (const match of plain.matchAll(URL_SCAN_RE)) {
		const index = match.index ?? 0;
		candidates.push({
			url: match[0],
			context: plain.slice(Math.max(0, index - CONTEXT_LOOKBEHIND), index),
		});
	}

	for (const { url, context } of candidates) {
		if (UNSUBSCRIBE_URL_RE.test(url) || UNSUBSCRIBE_KEYWORDS.some(keyword => context.toLowerCase().includes(keyword))) {
			return url.replace(/[.,;:]+$/, '');
		}
	}

	return undefined;
};

/**
 * 解析一封邮件的退订目标；无法退订时返回 null。
 *
 * 优先级：`List-Unsubscribe` 里的 http(s) 链接 → 正文中的退订链接 → `List-Unsubscribe` 里的 mailto
 */
export function extractUnsubscribeTarget(
	headers?: Record<string, string>[] | null,
	html?: string | null,
	text?: string | null,
): UnsubscribeTarget | null {
	let oneClick = false;
	const entries: string[] = [];

	for (const header of headers ?? []) {
		if (!header?.key || !header.value) continue;
		const key = header.key.trim().toLowerCase();
		if (key === 'list-unsubscribe') {
			entries.push(...splitHeaderEntries(header.value));
		} else if (key === 'list-unsubscribe-post' && header.value.toLowerCase().includes('one-click')) {
			oneClick = true;
		}
	}

	const urls = entries.filter(entry => HTTP_URL_RE.test(entry));
	const mailto = entries.find(entry => MAILTO_RE.test(entry));
	const url = urls.find(entry => /^https:/i.test(entry)) ?? urls[0];

	if (url) return { url, mailto, oneClick };

	const bodyUrl = findBodyUnsubscribeUrl(html, text);
	if (bodyUrl) return { url: bodyUrl, oneClick: false };

	return mailto ? { mailto, oneClick: false } : null;
}
