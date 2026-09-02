#include <node_api.h>
#include <dlfcn.h>
#include <string>

namespace {
using HandleJSON = char* (*)(const char*);
using FreeJSON = void (*)(char*);

void* library = nullptr;
HandleJSON handle_json = nullptr;
FreeJSON free_json = nullptr;

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

bool ReadString(napi_env env, napi_value value, std::string* output) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok) return false;
  output->resize(size + 1);
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, output->data(), size + 1, &written) != napi_ok) return false;
  output->resize(written);
  return true;
}

napi_value Initialize(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string path;
  if (argc != 1 || !ReadString(env, argv[0], &path)) {
    Throw(env, "initialize expects the absolute Swift library path");
    return nullptr;
  }
  if (library != nullptr) {
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
  }
  library = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (library == nullptr) {
    Throw(env, std::string("could not load macOS Desktop library: ") + dlerror());
    return nullptr;
  }
  handle_json = reinterpret_cast<HandleJSON>(dlsym(library, "cos_desktop_handle_json"));
  free_json = reinterpret_cast<FreeJSON>(dlsym(library, "cos_desktop_free_json"));
  if (handle_json == nullptr || free_json == nullptr) {
    Throw(env, "macOS Desktop library is missing its JSON ABI");
    return nullptr;
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value Handle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string request;
  if (argc != 1 || !ReadString(env, argv[0], &request)) {
    Throw(env, "handle expects one JSON string");
    return nullptr;
  }
  if (handle_json == nullptr || free_json == nullptr) {
    Throw(env, "macOS Desktop addon was not initialized");
    return nullptr;
  }
  char* raw = handle_json(request.c_str());
  if (raw == nullptr) {
    Throw(env, "macOS Desktop library returned no response");
    return nullptr;
  }
  napi_value result;
  const napi_status status = napi_create_string_utf8(env, raw, NAPI_AUTO_LENGTH, &result);
  free_json(raw);
  if (status != napi_ok) {
    Throw(env, "could not convert macOS Desktop response to JavaScript");
    return nullptr;
  }
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"initialize", nullptr, Initialize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"handle", nullptr, Handle, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
