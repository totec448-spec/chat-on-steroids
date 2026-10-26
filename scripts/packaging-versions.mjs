import { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS } from './packaging-targets.mjs';

export { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS };

export const TUNNEL_CLIENT = Object.freeze({
  version: 'v0.0.18',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '8d0da1ce79532d44ccc5ed5d8bd36cdfffba37dfd287c602d69635c8bb5db2b2' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'b73237513d50bf7acbeb960d80d9cbb6513879292f80ec1bd04b886fac1fe1c8' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '95595c6538b3f9872c1367592aede22e0d18ea7f6bdd51cd17fe0bf7e5ca8b26' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'ba7a0994f7dd15bc8708aa1602ecf54371a492319a641ab9c33dc00f1fd56bfe' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '3c82307316acd93c88a384b62af1d81d3f4cb0efa975f9c0bfaef922866a04c4' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'a5f3d70efc75f5e66ab5c67c44d272aa80b2736f93f875f165140517750ec035' })
    })
  })
});

export const RIPGREP = Object.freeze({
  version: '15.2.0',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'pc-windows-msvc', extension: 'zip', sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'pc-windows-msvc', extension: 'zip', sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'apple-darwin', extension: 'tar.gz', sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'apple-darwin', extension: 'tar.gz', sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'x86_64', triple: 'unknown-linux-musl', extension: 'tar.gz', sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c' }),
      arm64: Object.freeze({ upstreamArch: 'aarch64', triple: 'unknown-linux-musl', extension: 'tar.gz', sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915' })
    })
  })
});
