function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
}

function htmlToText(value: string): string {
	return decodeHtmlEntities(
		value
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
			.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
			.replace(/<\/(p|div|section|article|h[1-6]|li|blockquote|tr)>/gi, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<li\b[^>]*>/gi, "• ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function getMeta(html: string, key: string): string {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns = [
		new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
		new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
	];
	for (const pattern of patterns) {
		const match = pattern.exec(html);
		if (match?.[1]) return decodeHtmlEntities(match[1]).trim();
	}
	return "";
}

function findJsonCandidates(value: unknown, out: string[], depth = 0) {
	if (depth > 20 || value == null) return;
	if (Array.isArray(value)) {
		for (const item of value) findJsonCandidates(item, out, depth + 1);
		return;
	}
	if (typeof value !== "object") return;

	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (
			typeof child === "string" &&
			["articleBody", "content", "content_html", "content_text", "body", "description"].includes(key)
		) {
			const text = key === "articleBody" || key === "content_text" ? child.trim() : htmlToText(child);
			if (text.length >= 120) out.push(text);
		}
		findJsonCandidates(child, out, depth + 1);
	}
}

function extractJsonScriptCandidates(html: string): string[] {
	const candidates: string[] = [];
	const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
	for (const match of scripts) {
		const attrs = match[1] ?? "";
		const raw = (match[2] ?? "").trim();
		if (!raw || raw.length > 2_000_000) continue;
		if (!/application\/(?:ld\+json|json)|__NEXT_DATA__/i.test(attrs)) continue;
		try {
			findJsonCandidates(JSON.parse(raw), candidates);
		} catch {
			// Ignore non-JSON script blocks.
		}
	}
	return candidates;
}

function extractArticleTagCandidates(html: string): string[] {
	const candidates: string[] = [];
	for (const match of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
		const text = htmlToText(match[1] ?? "");
		if (text.length >= 120) candidates.push(text);
	}

	const classPatterns = ["article-content", "article__content", "article-detail", "articleDetail", "content-container"];
	for (const className of classPatterns) {
		const pattern = new RegExp(
			`<(?:div|section)\\b[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:div|section)>`,
			"gi",
		);
		for (const match of html.matchAll(pattern)) {
			const text = htmlToText(match[1] ?? "");
			if (text.length >= 120) candidates.push(text);
		}
	}
	return candidates;
}

function normalizeArticleInput(input: { articleId?: string; articleUrl?: string }) {
	const supplied = input.articleId?.trim() || input.articleUrl?.trim() || "";
	const match = supplied.match(/(?:articles\/)?(\d{5,})/);
	if (!match) throw new Error("请提供华尔街见闻文章 ID 或 /articles/{id} 文章链接");
	const articleId = match[1];
	return {
		articleId,
		articleUrl: `https://wallstreetcn.com/articles/${articleId}`,
	};
}

export async function getArticleDetail(input: {
	articleId?: string;
	articleUrl?: string;
	maxChars?: number;
}) {
	const { articleId, articleUrl } = normalizeArticleInput(input);
	const maxChars = Math.max(500, Math.min(3000, input.maxChars ?? 2400));

	const response = await fetch(articleUrl, {
		headers: {
			Accept: "text/html,application/xhtml+xml",
			"User-Agent": "Mozilla/5.0 (compatible; WallStreetCN-MCP/1.2)",
		},
		redirect: "follow",
	});
	if (!response.ok) throw new Error(`WallStreetCN article page HTTP ${response.status}`);

	const finalUrl = new URL(response.url);
	if (!/(^|\.)wallstreetcn\.com$/i.test(finalUrl.hostname)) {
		throw new Error("文章页面跳转到了非华尔街见闻域名，已停止读取");
	}

	const html = await response.text();
	const candidates = [...extractJsonScriptCandidates(html), ...extractArticleTagCandidates(html)]
		.map((value) => value.trim())
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);
	const publicText = candidates[0] ?? "";

	const title = getMeta(html, "og:title") || getMeta(html, "twitter:title") || "";
	const description =
		getMeta(html, "og:description") || getMeta(html, "description") || getMeta(html, "twitter:description") || "";
	const author = getMeta(html, "author");
	const publishedAt = getMeta(html, "article:published_time");

	const excerptSource = publicText || description;
	const excerpt = excerptSource.slice(0, maxChars);
	const truncated = excerptSource.length > excerpt.length;
	const likelyLimited = !publicText || publicText.length < 500;

	return {
		source: "WallStreetCN / 华尔街见闻公开文章页面",
		article_id: articleId,
		url: finalUrl.toString(),
		title,
		author: author || null,
		published_at: publishedAt || null,
		description: description || null,
		public_excerpt: excerpt || null,
		public_excerpt_chars: excerpt.length,
		truncated,
		content_scope: "public_page_visible_only",
		likely_limited_or_summary_only: likelyLimited,
		access_note:
			"仅提取无需登录或订阅即可从公开文章页面获得的内容；不绕过会员/付费限制。若文章受限，public_excerpt 可能只是公开摘要或可见片段。",
	};
}
