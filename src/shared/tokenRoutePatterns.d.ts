export declare function isTokenRouteRegexPattern(pattern: string): boolean;
export declare function isExactTokenRouteModelPattern(pattern: string): boolean;
export declare function parseTokenRouteRegexPattern(pattern: string): {
    regex: RegExp | null;
    error: string | null;
};
export declare function matchesTokenRouteModelPattern(model: string, pattern: string): boolean;
