import { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS } from './packaging-targets.mjs';

export { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS };

export const TUNNEL_CLIENT = Object.freeze({
  version: 'v0.0.19',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '1d0ecc3a54f2a51e27a635ac155f40fbb95df58c52cdeddf6c75532cc0bbeb25' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'a054bfb19d72b446cc9802a7987a17eab517502355d27b18e51814bbb0b32731' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: 'dff97674c77cac59e6ab3d901e6cff50fb17a5784c01d8959d1f4adb3afdf4bf' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: '2243d024b77af8ee4b4ab7a1447949e5fc8d82bcd2d51b178927f2da9e47ecfd' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '9ee9448592345a9dd1517fb79791ab54d24f051142eb92bcbe8cd355effc9142' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: '5a19e556c4a8736ab7a6fde6f0568f6e7411fa2dff21186fc15bc30e9b98a603' })
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
