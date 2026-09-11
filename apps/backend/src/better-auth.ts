import { passkey } from '@better-auth/passkey';
import { bunSqlAdapter } from '@ilbertt/better-auth-bun-sql';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { APIError, getAuthoritativeSessionFromCtx } from 'better-auth/api';
import type { SQL } from 'bun';

const API_PATH = '/api';

import {
  authorizeOwnerPasskeyRegistration,
  OWNER_DISPLAY_NAME,
  OWNER_SYNTHETIC_EMAIL,
  OWNER_USER_ID,
  OwnerRegistrationError,
  ownerRegistrationUser,
} from './owner-registration.ts';

export const AUTH_ROUTE_PATH = '/auth';
const BETTER_AUTH_API_BASE_PATH = `${API_PATH}${AUTH_ROUTE_PATH}`;
const BETTER_AUTH_TABLES_PREFIX = 'auth_';
const PASSKEY_RELYING_PARTY_NAME = 'Face Library';

function ownerRegistrationApiError(error: unknown): never {
  if (!(error instanceof OwnerRegistrationError)) {
    throw error;
  }

  const status =
    error.code === 'owner_registration_state_invalid'
      ? 'INTERNAL_SERVER_ERROR'
      : error.code === 'user_verification_required'
        ? 'UNAUTHORIZED'
        : 'FORBIDDEN';
  throw APIError.from(status, { code: error.code, message: error.message });
}

export function createAuthOptions({
  database,
  baseUrl,
  secret,
}: {
  database: SQL;
  baseUrl: URL;
  secret: string;
}): BetterAuthOptions {
  return {
    database: bunSqlAdapter({ sql: database, tablesPrefix: BETTER_AUTH_TABLES_PREFIX }),
    // The origin, never the href: better-auth drops `basePath` entirely when the base URL already
    // carries a path, so a `BASE_URL` with one would silently move every auth route. Its origin is
    // trusted automatically, which is why no `trustedOrigins` is needed.
    baseURL: baseUrl.origin,
    basePath: BETTER_AUTH_API_BASE_PATH,
    secret,
    plugins: [
      passkey({
        rpID: baseUrl.hostname,
        rpName: PASSKEY_RELYING_PARTY_NAME,
        origin: baseUrl.origin,
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
        registration: {
          requireSession: false,
          resolveUser: async ({ ctx }) => {
            try {
              const owner = await ctx.context.internalAdapter.findUserById(OWNER_USER_ID);
              return ownerRegistrationUser({ ownerExists: Boolean(owner) });
            } catch (error) {
              return ownerRegistrationApiError(error);
            }
          },
          afterVerification: async ({ ctx, verification, user }) => {
            try {
              if (user.id !== OWNER_USER_ID) {
                throw new OwnerRegistrationError('owner_registration_state_invalid');
              }

              const owner = await ctx.context.internalAdapter.findUserById(OWNER_USER_ID);
              const session = await getAuthoritativeSessionFromCtx(ctx);
              const action = authorizeOwnerPasskeyRegistration({
                ownerExists: Boolean(owner),
                sessionUserId: session?.user.id,
                userVerified: verification.registrationInfo?.userVerified === true,
              });

              if (action === 'create-owner') {
                await ctx.context.internalAdapter.createUser(
                  {
                    id: OWNER_USER_ID,
                    name: OWNER_DISPLAY_NAME,
                    email: OWNER_SYNTHETIC_EMAIL,
                    emailVerified: true,
                  },
                  { method: 'passkey' },
                );
              }

              return { userId: OWNER_USER_ID };
            } catch (error) {
              return ownerRegistrationApiError(error);
            }
          },
        },
        authentication: {
          afterVerification: ({ verification }) => {
            if (verification.authenticationInfo.userVerified !== true) {
              throw APIError.from('UNAUTHORIZED', {
                code: 'user_verification_required',
                message: 'Your authenticator must verify that it is you.',
              });
            }
          },
        },
      }),
    ],
    advanced: {
      cookiePrefix: 'face-library',
      database: {
        generateId: () => Bun.randomUUIDv7(),
      },
    },
  };
}

export function createAuth(input: { database: SQL; baseUrl: URL; secret: string }) {
  const auth = betterAuth(createAuthOptions(input));
  return {
    handler: (request: Request) => auth.handler(request),
    getSession: (headers: Headers) => auth.api.getSession({ headers }),
  };
}
export type Auth = ReturnType<typeof createAuth>;
