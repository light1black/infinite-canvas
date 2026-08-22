export type CorsDecision = {
    allowed: boolean;
    origins: string[];
};

/** Pure CORS policy used by the loopback agent; no credentials or network access required. */
export function evaluateCorsOrigin(origin: string | undefined, origins: string[], hasValidToken: boolean, bypass = false): CorsDecision {
    if (!origin || bypass) return { allowed: true, origins };
    if (origins.includes(origin)) return { allowed: true, origins };
    if (!hasValidToken) return { allowed: false, origins };
    return { allowed: true, origins: [...origins, origin] };
}
