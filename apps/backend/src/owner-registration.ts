export const OWNER_USER_ID = 'face-library-owner';
export const OWNER_SYNTHETIC_EMAIL = 'face-library-owner@face-library.invalid';
export const OWNER_DISPLAY_NAME = 'Face Library Owner';

export type OwnerRegistrationPersistenceState = {
  ownerExists: boolean;
  passkeyExists: boolean;
};

export type OwnerRegistrationErrorCode =
  | 'owner_already_registered'
  | 'owner_registration_state_invalid'
  | 'user_verification_required';

const ERROR_MESSAGES: Record<OwnerRegistrationErrorCode, string> = {
  owner_already_registered: 'This Face Library instance already has an owner.',
  owner_registration_state_invalid: 'The owner registration state is invalid.',
  user_verification_required: 'Your authenticator must verify that it is you.',
};

export class OwnerRegistrationError extends Error {
  readonly code: OwnerRegistrationErrorCode;

  constructor(code: OwnerRegistrationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OwnerRegistrationError';
    this.code = code;
  }
}

export function ownerRegistrationStatus({
  ownerExists,
  passkeyExists,
}: OwnerRegistrationPersistenceState): { ownerRegistered: boolean } {
  if (ownerExists !== passkeyExists) {
    throw new OwnerRegistrationError('owner_registration_state_invalid');
  }
  return { ownerRegistered: ownerExists };
}

export function ownerRegistrationUser({ ownerExists }: { ownerExists: boolean }): {
  id: string;
  name: string;
  displayName: string;
} {
  if (ownerExists) {
    throw new OwnerRegistrationError('owner_already_registered');
  }

  return {
    id: OWNER_USER_ID,
    // WebAuthn requires a stable username in addition to its opaque byte id. It is not a login
    // identifier in this passkey-only application, so keep it fixed and non-personal.
    name: OWNER_USER_ID,
    displayName: OWNER_DISPLAY_NAME,
  };
}

export function authorizeOwnerPasskeyRegistration({
  ownerExists,
  sessionUserId,
  userVerified,
}: {
  ownerExists: boolean;
  sessionUserId?: string;
  userVerified: boolean;
}): 'create-owner' | 'add-passkey' {
  if (!userVerified) {
    throw new OwnerRegistrationError('user_verification_required');
  }

  if (ownerExists) {
    if (sessionUserId !== OWNER_USER_ID) {
      throw new OwnerRegistrationError('owner_already_registered');
    }
    return 'add-passkey';
  }

  if (sessionUserId) {
    throw new OwnerRegistrationError('owner_registration_state_invalid');
  }

  return 'create-owner';
}
