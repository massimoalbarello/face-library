interface Window {
  FaceMap: { mount: typeof import("./embedding-map.ts").mount };
  FaceAuth: ReturnType<typeof import('better-auth/client').createAuthClient>;
}
