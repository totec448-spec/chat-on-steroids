{
  "targets": [
    {
      "target_name": "macos_desktop_addon",
      "sources": ["addon.cc"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "12.3",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
      }
    }
  ]
}
