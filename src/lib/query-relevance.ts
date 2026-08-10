const CHINESE_CODING_ALIASES: Array<[string, string[]]> = [
    ["工具", ["tool"]],
    ["注册", ["register"]],
    ["客户端", ["client"]],
    ["能力", ["capability"]],
    ["过滤", ["filter"]],
    ["搜索", ["search"]],
    ["工作区", ["workspace"]],
    ["项目", ["project"]],
    ["文件", ["file"]],
    ["配置", ["config"]],
    ["登录", ["login"]],
    ["认证", ["auth"]],
    ["权限", ["permission", "auth"]],
    ["路由", ["route"]],
    ["控制器", ["controller"]],
    ["命令", ["command"]],
    ["进程", ["process"]],
    ["输出", ["output"]],
    ["测试", ["test"]],
    ["构建", ["build"]],
    ["状态", ["status"]],
    ["差异", ["diff"]],
    ["补丁", ["patch"]],
];

const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "can",
    "code",
    "coding",
    "do",
    "does",
    "file",
    "files",
    "for",
    "from",
    "how",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "project",
    "projects",
    "that",
    "the",
    "this",
    "to",
    "use",
    "used",
    "using",
    "what",
    "when",
    "where",
    "which",
    "with",
]);

export interface RelevanceMatch {
    path: string;
    line: number;
    column: number;
    text: string;
}

export interface RankedFileMatches<T extends RelevanceMatch> {
    path: string;
    score: number;
    coverage: number;
    matches: T[];
}

/** Extract bounded, low-noise query tokens for search/ranking. */
export function significantQueryTokens(query: string, maxTokens = 10): string[] {
    const normalizedQuery = query.toLowerCase();
    const raw = normalizedQuery.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
    const tokens: string[] = [];
    const seen = new Set<string>();
    const push = (value: string): void => {
        const normalized = normalizeToken(value);
        if (
            tokens.length >= maxTokens ||
            normalized.length < 2 ||
            STOP_WORDS.has(normalized) ||
            seen.has(normalized)
        ) {
            return;
        }
        seen.add(normalized);
        tokens.push(normalized);
    };

    for (const [needle, aliases] of CHINESE_CODING_ALIASES) {
        if (!normalizedQuery.includes(needle)) continue;
        for (const alias of aliases) push(alias);
    }
    for (const item of raw) {
        if (STOP_WORDS.has(item)) continue;
        if (containsCjk(item) && item.length > 6) continue;
        push(item);
    }
    return tokens;
}

/** Build a bounded OR regex from significant query tokens. */
export function queryToSearchPattern(query: string, maxTokens = 10): string {
    const tokens = significantQueryTokens(query, maxTokens);
    const selected = tokens.length > 0 ? tokens : [query.trim().toLowerCase()];
    return selected.filter(Boolean).map(escapeRegex).join("|");
}

/**
 * Rank search matches at file level by distinct query-token coverage first,
 * then path relevance and repeated evidence. This prevents a common token from
 * flooding natural-language code exploration.
 */
export function rankMatchesByFile<T extends RelevanceMatch>(
    query: string,
    matches: readonly T[],
    maxFiles = 12,
    maxMatchesPerFile = 3,
): RankedFileMatches<T>[] {
    const tokens = significantQueryTokens(query);
    const normalizedQuery = query.trim().toLowerCase();
    const grouped = new Map<string, { matches: T[]; firstIndex: number }>();

    matches.forEach((match, index) => {
        const key = match.path.replaceAll("\\", "/");
        const bucket = grouped.get(key);
        if (bucket) bucket.matches.push(match);
        else grouped.set(key, { matches: [match], firstIndex: index });
    });

    const ranked = [...grouped.entries()].map(([path, bucket]) => {
        const normalizedPath = path.toLowerCase();
        const fileName = normalizedPath.split("/").at(-1) ?? normalizedPath;
        const evidence = `${normalizedPath}\n${bucket.matches.map((item) => item.text.toLowerCase()).join("\n")}`;
        const covered = tokens.filter((token) => evidenceIncludesToken(evidence, token));
        let score = covered.length * 100;

        if (normalizedQuery && fileName.includes(normalizedQuery)) score += 100;
        if (normalizedQuery && normalizedPath.includes(normalizedQuery)) score += 60;
        for (const token of tokens) {
            if (fileName.includes(token)) score += 30;
            else if (normalizedPath.includes(token)) score += 15;
        }
        score += Math.min(bucket.matches.length, 10) * 2;

        const selected = [...bucket.matches]
            .sort((left, right) => {
                const leftScore = matchEvidenceScore(left, tokens);
                const rightScore = matchEvidenceScore(right, tokens);
                return rightScore - leftScore || left.line - right.line || left.column - right.column;
            })
            .slice(0, maxMatchesPerFile);

        return {
            path,
            score,
            coverage: covered.length,
            matches: selected,
            firstIndex: bucket.firstIndex,
        };
    });

    ranked.sort(
        (left, right) =>
            right.coverage - left.coverage ||
            right.score - left.score ||
            left.path.localeCompare(right.path) ||
            left.firstIndex - right.firstIndex,
    );

    return ranked.slice(0, maxFiles).map(({ firstIndex: _firstIndex, ...item }) => item);
}

function matchEvidenceScore(match: RelevanceMatch, tokens: readonly string[]): number {
    const path = match.path.toLowerCase();
    const text = match.text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
        if (path.includes(token)) score += 5;
        if (evidenceIncludesToken(text, token)) score += 2;
    }
    return score;
}

function evidenceIncludesToken(value: string, token: string): boolean {
    if (value.includes(token)) return true;
    const variants = tokenVariants(token);
    return variants.some((variant) => variant !== token && value.includes(variant));
}

function containsCjk(value: string): boolean {
    return /[\u3400-\u9fff]/u.test(value);
}

function normalizeToken(token: string): string {
    if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
    if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
    if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
    if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
    if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
    return token;
}

function tokenVariants(token: string): string[] {
    const variants = [token, `${token}s`, `${token}ed`, `${token}ing`];
    if (token.endsWith("y") && token.length > 2) {
        variants.push(`${token.slice(0, -1)}ies`);
    }
    return variants;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
