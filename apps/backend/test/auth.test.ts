import { describe, test, expect } from 'bun:test';
import { OWNER_USER_ID, ownerRegistrationStatus, ownerRegistrationUser, authorizeOwnerPasskeyRegistration } from '../src/owner-registration.ts';

describe('PDF Signer owner registration policy', () => {
  test('requires a successfully verified first passkey and keeps one stable owner', () => {
    expect(ownerRegistrationStatus({ ownerExists: false, passkeyExists: false })).toEqual({ ownerRegistered: false });
    expect(ownerRegistrationUser({ ownerExists: false }).id).toBe(OWNER_USER_ID);
    expect(authorizeOwnerPasskeyRegistration({ ownerExists: false, userVerified: true })).toBe('create-owner');
    expect(() => authorizeOwnerPasskeyRegistration({ ownerExists: false, userVerified: false })).toThrow('verify');
  });
  test('blocks new ownership after registration and permits only the owner to add passkeys', () => {
    expect(() => ownerRegistrationUser({ ownerExists: true })).toThrow('already has an owner');
    for (const sessionUserId of [undefined, 'someone-else']) {
      expect(() => authorizeOwnerPasskeyRegistration({ ownerExists: true, sessionUserId, userVerified: true })).toThrow('already has an owner');
    }
    expect(authorizeOwnerPasskeyRegistration({ ownerExists: true, sessionUserId: OWNER_USER_ID, userVerified: true })).toBe('add-passkey');
    expect(() => authorizeOwnerPasskeyRegistration({ ownerExists: true, sessionUserId: OWNER_USER_ID, userVerified: false })).toThrow('verify');
  });
  test('fails closed on incomplete restored ownership', () => {
    expect(() => ownerRegistrationStatus({ ownerExists: true, passkeyExists: false })).toThrow('invalid');
    expect(() => ownerRegistrationStatus({ ownerExists: false, passkeyExists: true })).toThrow('invalid');
  });
});
