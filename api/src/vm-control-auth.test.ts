import { afterEach, describe, expect, test } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import {
    VM_CONTROL_TOKEN_ENV,
    VM_CONTROL_TOKEN_HEADER,
    validateVmControlAuthStartup,
    vmControlAuthMiddleware,
} from './vm-control-auth';

const originalFullDebianMode = process.env.SANDBOX_FULL_DEBIAN_MODE;
const originalToken = process.env[VM_CONTROL_TOKEN_ENV];

afterEach(() => {
    if (originalFullDebianMode === undefined) delete process.env.SANDBOX_FULL_DEBIAN_MODE;
    else process.env.SANDBOX_FULL_DEBIAN_MODE = originalFullDebianMode;
    if (originalToken === undefined) delete process.env[VM_CONTROL_TOKEN_ENV];
    else process.env[VM_CONTROL_TOKEN_ENV] = originalToken;
});

function runMiddleware(headerValue?: string) {
    let nextCalled = false;
    let statusCode: number | undefined;
    let responseBody: unknown;
    const request = {
        get: (header: string) => header === VM_CONTROL_TOKEN_HEADER ? headerValue : undefined,
    } as Request;
    const response = {
        status(code: number) {
            statusCode = code;
            return this;
        },
        json(body: unknown) {
            responseBody = body;
            return this;
        },
    } as unknown as Response;
    const next = (() => { nextCalled = true; }) as NextFunction;

    vmControlAuthMiddleware(request, response, next);
    return { nextCalled, statusCode, responseBody };
}

describe('full Debian VM control authentication', () => {
    test('requires a configured token at startup', () => {
        process.env.SANDBOX_FULL_DEBIAN_MODE = 'true';
        delete process.env[VM_CONTROL_TOKEN_ENV];
        expect(validateVmControlAuthStartup).toThrow(`${VM_CONTROL_TOKEN_ENV} is required`);
    });

    test('rejects missing and incorrect tokens', () => {
        process.env.SANDBOX_FULL_DEBIAN_MODE = 'true';
        process.env[VM_CONTROL_TOKEN_ENV] = 'manager-owned-token';

        expect(runMiddleware()).toEqual({
            nextCalled: false,
            statusCode: 401,
            responseBody: { message: 'Unauthorized' },
        });
        expect(runMiddleware('caller-controlled-token').statusCode).toBe(401);
    });

    test('accepts the manager token', () => {
        process.env.SANDBOX_FULL_DEBIAN_MODE = 'true';
        process.env[VM_CONTROL_TOKEN_ENV] = 'manager-owned-token';
        expect(runMiddleware('manager-owned-token')).toEqual({
            nextCalled: true,
            statusCode: undefined,
            responseBody: undefined,
        });
    });

    test('does not affect hardened mode', () => {
        process.env.SANDBOX_FULL_DEBIAN_MODE = 'false';
        delete process.env[VM_CONTROL_TOKEN_ENV];
        expect(validateVmControlAuthStartup()).toBeUndefined();
        expect(runMiddleware()).toEqual({
            nextCalled: true,
            statusCode: undefined,
            responseBody: undefined,
        });
    });
});