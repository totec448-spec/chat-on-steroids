import { t } from './i18n.js';

/** Localize the updater's authored reasons; unknown external diagnostics remain verbatim. */
export function updateErrorText(source: string): string {
  switch (source) {
    case 'GitHub could not be reached':
      return t('GitHub could not be reached. Check your connection');
    case 'There is no downloaded update to install yet':
      return t('The downloaded update could not be confirmed for installation.');
    case 'Could not read plugin-refresh state':
      return t('The saved plugin update state could not be read.');
    case 'the latest release has no usable version tag':
    case 'the release page named no usable version tag':
      return t('The release information has no valid version number.');
    case 'it is not the published file':
    case 'the staged artifact changed after verification':
      return t('The downloaded update did not match the published checksum.');
  }
  const http = /^(?:the release page|latest) answered (\d{3})$/.exec(source);
  if (http) return t('Could not check for updates: HTTP {0}.', [http[1]]);
  const download = /^(.+) answered (\d{3})$/.exec(source);
  if (download) return t('Could not download {0}: HTTP {1}.', [download[1], download[2]]);
  const absent = /^release (\d+\.\d+\.\d+) publishes no (.+)$/.exec(source);
  if (absent) return t('Release {0} does not include {1}.', [absent[1], absent[2]]);
  if (/^downloading .+ returned no content$/.test(source)) return t('The update download returned no data.');
  if (/^.+ is not the published file: sha256 [a-f\d]{64} instead of [a-f\d]{64}$/.test(source)) {
    return t('The downloaded update did not match the published checksum.');
  }
  return t(source);
}

export function updateErrorNextStep(source: string): string {
  return source === 'Could not read plugin-refresh state'
    ? t('Save a Diagnostics report from Activity for help with recovery. The saved state has been kept.')
    : t('Choose Update all to retry.');
}
