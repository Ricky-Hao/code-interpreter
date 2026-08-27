import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const VM_CONTROL_TOKEN_ENV = 'SANDBOX_VM_CONTROL_TOKEN';
export const VM_CONTROL_TOKEN_HEADER = 'X-CodeAPI-VM-Control-Token';

function fullDebianModeEnabled(): boolean {
    return process.env.SANDBOX_FULL_DEBIAN_MODE === 'true';
}

function configuredToken(): string {
    return (process.env[VM_CONTROL_TOKEN_ENV] ?? '').trim();
}

export function validateVmControlAuthStartup(): void {
    if (fullDebianModeEnabled() && !configuredToken()) {
        throw new Error(`${VM_CONTROL_TOKEN_ENV} is required in full Debian mode`);
    }
}

function tokensMatch(expected: string, provided: string): boolean {
    const expectedDigest = createHash('sha256').update(expected).digest();
    const providedDigest = createHash('sha256').update(provided).digest();
    return timingSafeEqual(expectedDigest, providedDigest);
}

export function vmControlAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!fullDebianModeEnabled()) {
        next();
        return;
    }

    const expected = configuredToken();
    const provided = req.get(VM_CONTROL_TOKEN_HEADER) ?? '';
    if (!expected || !tokensMatch(expected, provided)) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
    }
    next();
}