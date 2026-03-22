function readRegexQuantifierLength(pattern, startIndex) {
    const ch = pattern[startIndex];
    if (ch === '*' || ch === '+' || ch === '?')
        return 1;
    if (ch !== '{')
        return 0;
    let index = startIndex + 1;
    let sawDigit = false;
    while (index < pattern.length && /\d/.test(pattern[index])) {
        sawDigit = true;
        index += 1;
    }
    if (!sawDigit)
        return 0;
    if (pattern[index] === ',') {
        index += 1;
        while (index < pattern.length && /\d/.test(pattern[index])) {
            index += 1;
        }
    }
    if (pattern[index] !== '}')
        return 0;
    return index - startIndex + 1;
}
function isSafeRegexPatternBody(body) {
    if (!body || body.length > 256)
        return false;
    if (!/^[a-z0-9\s.^$|()[\]{}+*?\\:_/-]+$/i.test(body))
        return false;
    if (body.includes('(?=') || body.includes('(?!') || body.includes('(?<=') || body.includes('(?<!') || body.includes('(?<')) {
        return false;
    }
    if (/(^|[^\\])\\[1-9]/.test(body)) {
        return false;
    }
    const groupStack = [];
    let escaped = false;
    let inCharClass = false;
    for (let index = 0; index < body.length; index += 1) {
        const ch = body[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (inCharClass) {
            if (ch === ']')
                inCharClass = false;
            continue;
        }
        if (ch === '[') {
            inCharClass = true;
            continue;
        }
        if (ch === '(') {
            if (body[index + 1] === '?') {
                if (body[index + 2] !== ':')
                    return false;
                groupStack.push({ hasInnerQuantifier: false, hasAlternation: false });
                index += 2;
                continue;
            }
            groupStack.push({ hasInnerQuantifier: false, hasAlternation: false });
            continue;
        }
        if (ch === '|') {
            if (groupStack.length > 0) {
                groupStack[groupStack.length - 1].hasAlternation = true;
            }
            continue;
        }
        if (ch === ')') {
            const group = groupStack.pop();
            if (!group)
                return false;
            const quantifierLength = readRegexQuantifierLength(body, index + 1);
            if (quantifierLength > 0 && (group.hasInnerQuantifier || group.hasAlternation)) {
                return false;
            }
            const parent = groupStack[groupStack.length - 1];
            if (parent && (group.hasInnerQuantifier || quantifierLength > 0)) {
                parent.hasInnerQuantifier = true;
            }
            continue;
        }
        const quantifierLength = readRegexQuantifierLength(body, index);
        if (quantifierLength > 0) {
            if (groupStack.length > 0) {
                groupStack[groupStack.length - 1].hasInnerQuantifier = true;
            }
            index += quantifierLength - 1;
        }
    }
    return !escaped && !inCharClass && groupStack.length === 0;
}
function globToRegexSource(glob) {
    let source = '';
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === '*') {
            source += '.*';
            continue;
        }
        if (ch === '?') {
            source += '.';
            continue;
        }
        if (ch === '[') {
            const closeIndex = glob.indexOf(']', i + 1);
            if (closeIndex > i + 1) {
                source += glob.slice(i, closeIndex + 1);
                i = closeIndex;
                continue;
            }
            source += '\\[';
            continue;
        }
        source += ch.replace(/[\\^$+?.()|{}]/g, '\\$&');
    }
    return source;
}
const compiledGlobCache = new Map();
const matchCache = new Map();
const MATCH_CACHE_LIMIT = 4000;
function matchesGlobPattern(model, pattern) {
    let re = compiledGlobCache.get(pattern);
    if (re === undefined) {
        try {
            re = new RegExp(`^${globToRegexSource(pattern)}$`);
        }
        catch {
            re = null;
        }
        compiledGlobCache.set(pattern, re);
    }
    return re ? re.test(model) : false;
}
export function isTokenRouteRegexPattern(pattern) {
    return pattern.trim().toLowerCase().startsWith('re:');
}
export function isExactTokenRouteModelPattern(pattern) {
    const normalized = pattern.trim();
    if (!normalized)
        return false;
    if (isTokenRouteRegexPattern(normalized))
        return false;
    return !/[\*\?]/.test(normalized);
}
export function parseTokenRouteRegexPattern(pattern) {
    if (!isTokenRouteRegexPattern(pattern))
        return { regex: null, error: null };
    const body = pattern.trim().slice(3).trim();
    if (!body)
        return { regex: null, error: 're: 后缺少正则表达式' };
    if (!isSafeRegexPatternBody(body)) {
        return { regex: null, error: '出于安全原因不支持该正则表达式' };
    }
    try {
        return { regex: new RegExp(body), error: null };
    }
    catch (error) {
        return { regex: null, error: error?.message || '无效正则' };
    }
}
export function matchesTokenRouteModelPattern(model, pattern) {
    const normalized = (pattern || '').trim();
    if (!normalized)
        return false;
    if (normalized === model)
        return true;
    const cacheKey = `${model}\0${normalized}`;
    const cached = matchCache.get(cacheKey);
    if (cached !== undefined)
        return cached;
    let result;
    if (isTokenRouteRegexPattern(normalized)) {
        const parsed = parseTokenRouteRegexPattern(normalized);
        result = !!parsed.regex && parsed.regex.test(model);
    }
    else {
        result = matchesGlobPattern(model, normalized);
    }
    if (matchCache.size >= MATCH_CACHE_LIMIT)
        matchCache.clear();
    matchCache.set(cacheKey, result);
    return result;
}
