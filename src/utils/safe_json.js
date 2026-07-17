export function safeJSON(str, fallback = null) {
    try {
        return JSON.parse(str);
    } catch {
        return fallback;
    }
}

export function safeReadJSON(readFn, fallback = null) {
    try {
        const raw = readFn();
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}
