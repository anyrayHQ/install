// One table for both lanes. The names must match the engine's lane table in
// monorepo connect/src/util/desktopUpdate.ts, or an installed app rejects its feed.
const CHANNELS = {
  staging: {
    feed: 'connect-desktop-staging',
    artifact: 'anyray-connect-desktop-staging',
    tagPrefix: 'connect-desktop-staging-v',
    marker: 'staging',
  },
  stable: {
    feed: 'connect-desktop',
    artifact: 'anyray-connect-desktop',
    tagPrefix: 'connect-desktop-v',
    marker: 'production',
  },
};

// Unversioned copies on the stable feed release, so the download page keeps one
// link per OS. Keys are the versioned-name suffix; values are the published name.
export const STABLE_DOWNLOADS = {
  '-macos-universal.pkg': 'anyray-connect-desktop-macos-universal.pkg',
  '-windows-x64.msi': 'anyray-connect-desktop-windows-x64.msi',
  '-linux-x64.deb': 'anyray-connect-desktop-linux-x64.deb',
  '-linux-x64.rpm': 'anyray-connect-desktop-linux-x64.rpm',
};

export function channelConfig(channel) {
  const config = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : undefined;
  if (!config) throw new Error(`Unknown desktop channel: ${channel}`);
  return config;
}

export const releaseTag = (channel, version, sourceSha) =>
  `${channelConfig(channel).tagPrefix}${version}-${sourceSha.slice(0, 12)}`;

// What the feed release serves, as { name, source } with source relative to the
// release's assets directory. The manifest stays first: publishFeed reads it to
// refuse a downgrade.
export function feedFiles(channel, version) {
  const { feed } = channelConfig(channel);
  const files = [`${feed}.json`, `${feed}.json.asc`].map((name) => ({ name, source: name }));
  if (channel !== 'stable') return files;
  return [
    ...files,
    ...Object.entries(STABLE_DOWNLOADS).map(([suffix, name]) => ({
      name,
      source: `anyray-connect-desktop-${version}${suffix}`,
    })),
  ];
}
