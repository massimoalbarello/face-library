import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';

window.FaceAuth = createAuthClient({
  baseURL: window.location.origin,
  plugins: [passkeyClient()],
});
