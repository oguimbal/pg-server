export function expectNever(value: never): void {
    return value;
}

export function assertNever(value: never, msg?: string): never {
    throw new Error(`${msg ?? ''} ${JSON.stringify(value)}`);
}

export function nullish(value: any): boolean {
    return value === null || value === undefined;
}

export const isDebug = process.env.DEBUG_PG_SERVER === 'true';

export function isThenable(value: any): value is Promise<any> {
    return value
        && typeof value === 'object'
        && typeof value.then === 'function';
}