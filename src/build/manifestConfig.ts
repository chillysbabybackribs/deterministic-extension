export type ExtensionManifest = {
  key?: string;
  host_permissions?: string[];
};

export type ClerkManifestEnv = {
  clerkFrontendApi?: string;
  crxPublicKey?: string;
};

export function applyClerkManifestEnv(
  manifest: ExtensionManifest,
  { clerkFrontendApi, crxPublicKey }: ClerkManifestEnv
): ExtensionManifest {
  const nextManifest: ExtensionManifest = {
    ...manifest,
    host_permissions: [...(manifest.host_permissions ?? [])]
  };

  if (crxPublicKey?.trim()) {
    nextManifest.key = crxPublicKey.trim();
  }

  const clerkHostPermission = toHostPermission(clerkFrontendApi);
  if (clerkHostPermission && !nextManifest.host_permissions?.includes(clerkHostPermission)) {
    nextManifest.host_permissions?.push(clerkHostPermission);
  }

  return nextManifest;
}

export function toHostPermission(frontendApi?: string): string | undefined {
  const value = frontendApi?.trim();
  if (!value) {
    return undefined;
  }

  const normalizedValue = value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
  const origin = new URL(normalizedValue).origin;
  return `${origin}/*`;
}
