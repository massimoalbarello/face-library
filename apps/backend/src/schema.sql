-- Generated with:
--   bun run --bun better-auth generate --config src/lib/auth/better-auth.ts --output src/db/migrations/0000-better-auth-schema.sql --yes

create table if not exists "auth_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "auth_session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_user" ("id") on delete cascade);

create table if not exists "auth_account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "auth_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table if not exists "auth_passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);

create index if not exists "auth_session_userId_idx" on "auth_session" ("userId");

create index if not exists "auth_account_userId_idx" on "auth_account" ("userId");

create index if not exists "auth_verification_identifier_idx" on "auth_verification" ("identifier");

create index if not exists "auth_passkey_userId_idx" on "auth_passkey" ("userId");

create index if not exists "auth_passkey_credentialID_idx" on "auth_passkey" ("credentialID");

create unique index if not exists "auth_account_issuer_accountId_uidx" on "auth_account" ("issuer", "accountId");
