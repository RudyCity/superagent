// Exact-window, in-process Windows UI Automation boundary for Desktop Live.
// No mouse coordinates, SendInput, script execution, focus stealing, clipboard,
// monitor enumeration or fallbacks. Build separately; never loaded on a network route.
#include <windows.h>
#include <unknwn.h>
#include <objbase.h>
#include <uiautomation.h>
#include <dwmapi.h>
#include <sddl.h>
#include <wrl/client.h>
#include <oleauto.h>
#include <algorithm>
#include <cstdint>
#include <cwchar>
#include <limits>
#include <string>
#include <vector>
#include <memory>
#include <cstdio>

using Microsoft::WRL::ComPtr;

namespace {
struct ScopedCo {
  HRESULT hr;
  ScopedCo() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ScopedCo() { if (SUCCEEDED(hr)) CoUninitialize(); }
};
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct NativeResult {
  std::string json;
  ComPtr<IUIAutomationElement> target;
  ComPtr<IUIAutomationInvokePattern> invoke;
  ComPtr<IUIAutomationValuePattern> value;
  ComPtr<IUIAutomationScrollPattern> scroll;
  bool focused = false;
};

bool onlyDigits(const wchar_t* v, size_t maxLength) {
  if (!v || !*v) return false;
  size_t n = 0;
  for (const wchar_t* p = v; *p; ++p) {
    if (++n > maxLength || *p < L'0' || *p > L'9') return false;
  }
  return true;
}
bool parseU64(const wchar_t* s, uint64_t& out) {
  if (!onlyDigits(s, 20)) return false;
  uint64_t acc = 0;
  for (const wchar_t* p = s; *p; ++p) {
    const uint64_t digit = static_cast<uint64_t>(*p - L'0');
    if (acc > (UINT64_MAX - digit) / 10) return false;
    acc = acc * 10 + digit;
  }
  out = acc;
  return acc != 0;
}
bool verifyDefaultDesktop() {
  HDESK d = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!d) return false;
  wchar_t name[128]{};
  DWORD bytes = 0;
  bool valid = GetUserObjectInformationW(
    d, UOI_NAME, name, sizeof(name), &bytes) && wcscmp(name, L"Default") == 0;
  CloseDesktop(d);
  return valid;
}
bool tokenSid(HANDLE process, std::wstring& out) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) return false;
  Handle token(raw);
  DWORD bytes = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &bytes);
  if (!bytes || bytes > 65536) return false;
  std::vector<BYTE> buffer(bytes);
  if (!GetTokenInformation(token.value, TokenUser, buffer.data(), bytes, &bytes)) return false;
  auto* user = reinterpret_cast<TOKEN_USER*>(buffer.data());
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &sid)) return false;
  out = sid;
  LocalFree(sid);
  return true;
}
bool integrity(HANDLE process, DWORD& rid) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) return false;
  Handle token(raw);
  DWORD bytes = 0;
  GetTokenInformation(token.value, TokenIntegrityLevel, nullptr, 0, &bytes);
  if (!bytes || bytes > 65536) return false;
  std::vector<BYTE> buffer(bytes);
  if (!GetTokenInformation(token.value, TokenIntegrityLevel, buffer.data(), bytes, &bytes)) return false;
  auto* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buffer.data());
  auto* sid = label->Label.Sid;
  if (!IsValidSid(sid)) return false;
  UCHAR count = *GetSidSubAuthorityCount(sid);
  if (!count) return false;
  rid = *GetSidSubAuthority(sid, count - 1);
  return true;
}
bool verifyWindow(
  const wchar_t* nativeId, unsigned int pid, const wchar_t* birth,
  const wchar_t* userSid, const wchar_t* sessionId, HWND& hwnd,
  int* reason = nullptr
) {
  const auto rejected = [reason](int stage) -> bool {
    if (reason) *reason = stage;
    return false;
  };
  if (!nativeId || !birth || !userSid || !sessionId || pid == 0 ||
      wcsncmp(birth, L"filetime:", 9) != 0 ||
      wcsncmp(sessionId, L"session:", 8) != 0 ||
      wcsncmp(userSid, L"S-1-", 4) != 0) return rejected(-31);
  uint64_t handleId = 0, createdId = 0, sessionValue = 0;
  if (!parseU64(nativeId, handleId) ||
      !parseU64(birth + 9, createdId) ||
      !onlyDigits(sessionId + 8, 10)) return rejected(-32);
  // Interactive session 0 is typically noninteractive and must not dispatch.
  for (const wchar_t* p = sessionId + 8; *p; ++p) {
    sessionValue = sessionValue * 10 + (*p - L'0');
    if (sessionValue > UINT32_MAX) return rejected(-33);
  }
  if (sessionValue == 0 ||
      handleId > static_cast<uint64_t>(UINTPTR_MAX)) return rejected(-34);
  hwnd = reinterpret_cast<HWND>(static_cast<UINT_PTR>(handleId));
  if (!verifyDefaultDesktop()) return rejected(-351);
  if (!IsWindow(hwnd)) return rejected(-352);
  if (!IsWindowVisible(hwnd)) return rejected(-353);
  if (IsIconic(hwnd)) return rejected(-354);
  if (GetAncestor(hwnd, GA_ROOT) != hwnd) return rejected(-355);
  if (GetForegroundWindow() != hwnd) return rejected(-356);
  DWORD actualPid = 0;
  DWORD thread = GetWindowThreadProcessId(hwnd, &actualPid);
  if (!thread || actualPid != pid) return rejected(-36);
  DWORD actualSession = 0;
  if (!ProcessIdToSessionId(pid, &actualSession) ||
      actualSession != sessionValue) return rejected(-37);
  DWORD localSession = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &localSession) ||
      actualSession != localSession) return rejected(-38);
  int cloak = 1;
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloak, sizeof(cloak))) ||
      cloak != 0) return rejected(-39);
  DWORD affinity = 1;
  if (!GetWindowDisplayAffinity(hwnd, &affinity) || affinity != WDA_NONE) return rejected(-40);
  RECT r{};
  if (!GetWindowRect(hwnd, &r) ||
      r.right <= r.left || r.bottom <= r.top ||
      r.right - r.left > 8192 || r.bottom - r.top > 8192) return rejected(-41);
  // A secure desktop or mismatched DPI space must never authorize input.
  if (!SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return rejected(-42);
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process.value) return rejected(-43);
  FILETIME creation{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process.value, &creation, &exit, &kernel, &user)) return rejected(-44);
  const uint64_t nativeBirth =
    (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  if (nativeBirth != createdId) return rejected(-45);
  std::wstring sid;
  if (!tokenSid(process.value, sid) || _wcsicmp(sid.c_str(), userSid) != 0) return rejected(-46);
  Handle local(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentProcessId()));
  if (!local.value) return rejected(-47);
  std::wstring ownSid;
  if (!tokenSid(local.value, ownSid) || _wcsicmp(ownSid.c_str(), sid.c_str()) != 0) return rejected(-48);
  DWORD targetIntegrity = 0, ownIntegrity = 0;
  if (!integrity(process.value, targetIntegrity) ||
      !integrity(local.value, ownIntegrity) || targetIntegrity > ownIntegrity) return rejected(-49);
  return true;
}

std::string utf8(const wchar_t* value, int length = -1) {
  if (!value) return {};
  if (length < 0) length = static_cast<int>(wcslen(value));
  if (length <= 0 || length > 8192) return {};
  const int needed = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, length,
                                        nullptr, 0, nullptr, nullptr);
  if (needed <= 0 || needed > 16384) return {};
  std::string result(static_cast<size_t>(needed), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, length,
                           result.data(), needed, nullptr, nullptr)) return {};
  return result;
}
std::string jsonQuote(const std::string& s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 32 || c == 127) {
          char escape[8]{};
          std::snprintf(escape, sizeof(escape), "\\u%04x", c);
          out += escape;
        } else out += static_cast<char>(c);
    }
  }
  out += "\"";
  return out;
}
std::string optionalString(BSTR text) {
  if (!text || !SysStringLen(text)) return "null";
  std::string s = utf8(text, SysStringLen(text));
  if (s.empty() || s.find_first_not_of(" \t\r\n") == std::string::npos) return "null";
  return jsonQuote(s);
}
std::string roleFromType(CONTROLTYPEID id) {
  switch (id) {
    case UIA_ButtonControlTypeId: return "button";
    case UIA_EditControlTypeId: return "edit";
    case UIA_HyperlinkControlTypeId: return "hyperlink";
    case UIA_MenuItemControlTypeId: return "menuitem";
    case UIA_CheckBoxControlTypeId: return "checkbox";
    case UIA_RadioButtonControlTypeId: return "radiobutton";
    case UIA_ComboBoxControlTypeId: return "combobox";
    case UIA_ListItemControlTypeId: return "listitem";
    case UIA_TabItemControlTypeId: return "tabitem";
    case UIA_SliderControlTypeId: return "slider";
    case UIA_SpinnerControlTypeId: return "spinner";
    default: return "";
  }
}
bool validRef(const wchar_t* nativeRef, std::wstring& id) {
  if (!nativeRef || wcsncmp(nativeRef, L"automationId:", 13) != 0) return false;
  id = nativeRef + 13;
  if (id.empty() || id.size() > 80) return false;
  for (wchar_t ch : id) {
    if (!((ch >= L'A' && ch <= L'Z') || (ch >= L'a' && ch <= L'z') ||
          (ch >= L'0' && ch <= L'9') || ch == L'_' || ch == L'.' ||
          ch == L'-')) return false;
  }
  return true;
}
bool resolve(
  HWND hwnd, unsigned int pid, const wchar_t* nativeRef, NativeResult& result
) {
  std::wstring automationId;
  if (!validRef(nativeRef, automationId)) return false;
  ComPtr<IUIAutomation> automation;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&automation)))) return false;
  ComPtr<IUIAutomationElement> root;
  if (FAILED(automation->ElementFromHandle(hwnd, &root)) || !root) return false;
  int rootPid = 0;
  if (FAILED(root->get_CurrentProcessId(&rootPid)) || rootPid != static_cast<int>(pid))
    return false;
  VARIANT property{};
  VariantInit(&property);
  V_VT(&property) = VT_BSTR;
  V_BSTR(&property) = SysAllocStringLen(automationId.c_str(),
                                      static_cast<UINT>(automationId.size()));
  if (!V_BSTR(&property)) return false;
  ComPtr<IUIAutomationCondition> condition;
  HRESULT condResult =
    automation->CreatePropertyCondition(UIA_AutomationIdPropertyId, property, &condition);
  VariantClear(&property);
  if (FAILED(condResult) || !condition) return false;
  ComPtr<IUIAutomationElementArray> matches;
  if (FAILED(root->FindAll(TreeScope_Subtree, condition.Get(), &matches)) || !matches) return false;
  int count = 0;
  if (FAILED(matches->get_Length(&count)) || count != 1) return false; // duplicate IDs DENIED
  if (FAILED(matches->GetElement(0, &result.target)) || !result.target) return false;
  int owner = 0;
  BOOL enabled = FALSE, offscreen = TRUE, focus = FALSE, isPassword = TRUE;
  RECT r{};
  CONTROLTYPEID type = 0;
  if (FAILED(result.target->get_CurrentProcessId(&owner)) || owner != static_cast<int>(pid) ||
      FAILED(result.target->get_CurrentIsEnabled(&enabled)) || !enabled ||
      FAILED(result.target->get_CurrentIsOffscreen(&offscreen)) || offscreen ||
      FAILED(result.target->get_CurrentHasKeyboardFocus(&focus)) ||
      FAILED(result.target->get_CurrentIsPassword(&isPassword)) || isPassword ||
      FAILED(result.target->get_CurrentBoundingRectangle(&r)) ||
      FAILED(result.target->get_CurrentControlType(&type))) return false;
  const std::string role = roleFromType(type);
  if (role.empty() || r.right <= r.left || r.bottom <= r.top) return false;
  RECT windowRect{};
  if (!GetWindowRect(hwnd, &windowRect) ||
      r.left < windowRect.left || r.top < windowRect.top ||
      r.right > windowRect.right || r.bottom > windowRect.bottom) return false;
  BSTR name = nullptr, help = nullptr;
  const HRESULT nameResult = result.target->get_CurrentName(&name);
  const HRESULT helpResult = result.target->get_CurrentHelpText(&help);
  if (FAILED(nameResult) || FAILED(helpResult)) {
    if (name) SysFreeString(name);
    if (help) SysFreeString(help);
    return false;
  }
  // QueryPattern is read-only here; only Act can call semantic methods.
  ComPtr<IUnknown> pattern;
  if (SUCCEEDED(result.target->GetCurrentPattern(UIA_InvokePatternId, &pattern)) && pattern)
    pattern.As(&result.invoke);
  pattern.Reset();
  if (SUCCEEDED(result.target->GetCurrentPattern(UIA_ValuePatternId, &pattern)) && pattern)
    pattern.As(&result.value);
  pattern.Reset();
  if (SUCCEEDED(result.target->GetCurrentPattern(UIA_ScrollPatternId, &pattern)) && pattern)
    pattern.As(&result.scroll);
  BOOL readonly = TRUE;
  if (result.value && (FAILED(result.value->get_CurrentIsReadOnly(&readonly)) || readonly))
    result.value.Reset();
  result.focused = focus == TRUE;
  std::string label = optionalString(name);
  std::string description = optionalString(help);
  SysFreeString(name);
  SysFreeString(help);
  // value intentionally null: existing Windows accessibility snapshot has
  // value:null. It is NOT retrieved or sent to the controller (no secret leak).
  const auto boolean = [](bool b) -> const char* { return b ? "true" : "false"; };
  result.json = std::string("{\"nativeRef\":") + jsonQuote(utf8(nativeRef)) +
    ",\"role\":" + jsonQuote(role) + ",\"label\":" + label +
    ",\"description\":" + description + ",\"value\":null" +
    ",\"actionable\":true,\"focused\":" + boolean(result.focused) +
    ",\"bounds\":{\"x\":" + std::to_string(r.left) +
      ",\"y\":" + std::to_string(r.top) +
      ",\"width\":" + std::to_string(r.right - r.left) +
      ",\"height\":" + std::to_string(r.bottom - r.top) +
    "},\"center\":{\"x\":" + std::to_string((r.left + r.right) / 2.0) +
      ",\"y\":" + std::to_string((r.top + r.bottom) / 2.0) +
    "},\"patterns\":{\"invoke\":" + boolean(!!result.invoke) +
      ",\"value\":" + boolean(!!result.value) +
      ",\"scroll\":" + boolean(!!result.scroll) + "}}";
  return result.json.size() <= 16384;
}
bool inputTextSafe(const wchar_t* text) {
  if (!text) return false;
  const size_t len = wcslen(text);
  if (len == 0 || len > 4096) return false;
  for (size_t i = 0; i < len; ++i) {
    if (text[i] <= 0x1f || text[i] == 0x7f) return false;
  }
  return true;
}
ScrollAmount amount(int n) {
  if (n == 0) return ScrollAmount_NoAmount;
  if (n > 0) return n == 1 ? ScrollAmount_SmallIncrement : ScrollAmount_LargeIncrement;
  return n == -1 ? ScrollAmount_SmallDecrement : ScrollAmount_LargeDecrement;
}
} // namespace

// Native functions must remain synchronous. External callers cannot select a
// DLL path, command, monitor, coordinate, or arbitrary UI Automation property.
extern "C" __declspec(dllexport) int __cdecl WindowsRemoteInspect(
  const wchar_t* hwndText, unsigned int pid, const wchar_t* birth,
  const wchar_t* sid, const wchar_t* session, const wchar_t* nativeRef,
  char* output, unsigned int capacity
) noexcept {
  try {
    if (!output || capacity < 32 || capacity > 32768) return -1;
    ScopedCo com;
    if (FAILED(com.hr)) return -2;
    HWND hwnd = nullptr;
    int stage = -3;
    if (!verifyWindow(hwndText, pid, birth, sid, session, hwnd, &stage)) return stage;
    NativeResult state;
    if (!resolve(hwnd, pid, nativeRef, state)) return -4;
    // HWND could change while UIA was walking a tree; verify at both ends.
    HWND again = nullptr;
    if (!verifyWindow(hwndText, pid, birth, sid, session, again) ||
        again != hwnd || state.json.size() + 1 > capacity) return -5;
    memcpy(output, state.json.c_str(), state.json.size() + 1);
    return static_cast<int>(state.json.size());
  } catch (...) { return -100; }
}

extern "C" __declspec(dllexport) int __cdecl WindowsRemoteAct(
  const wchar_t* hwndText, unsigned int pid, const wchar_t* birth,
  const wchar_t* sid, const wchar_t* session, const wchar_t* nativeRef,
  const char* expectedObservation, unsigned int expectedLength,
  int kind, const wchar_t* text, int deltaX, int deltaY,
  int (__cdecl *authorizeNow)()
) noexcept {
  try {
    if (!expectedObservation || expectedLength < 16 || expectedLength > 16384 ||
        kind < 1 || kind > 3) return -1;
    ScopedCo com;
    if (FAILED(com.hr)) return -2;
    HWND hwnd = nullptr;
    if (!verifyWindow(hwndText, pid, birth, sid, session, hwnd)) return -3;
    NativeResult state;
    if (!resolve(hwnd, pid, nativeRef, state) ||
        expectedLength != state.json.size() ||
        memcmp(expectedObservation, state.json.data(), expectedLength) != 0) return -4;
    // FINAL immutable HWND, PID, birth, SID, session, foreground, desktop check.
    HWND again = nullptr;
    if (!verifyWindow(hwndText, pid, birth, sid, session, again) || again != hwnd)
      return -5;
    HRESULT hr = E_ACCESSDENIED;
    switch (kind) {
      case 1:
        if (!state.invoke) return -6;
        if (!authorizeNow || authorizeNow() != 1) return -8;
        hr = state.invoke->Invoke();
        break;
      case 2:
        if (!state.value || !state.focused || !inputTextSafe(text) ||
            state.json.find("\"role\":\"edit\"") == std::string::npos) return -6;
        { BSTR value = SysAllocString(text);
          if (!value) return -6;
          if (!authorizeNow || authorizeNow() != 1) { SysFreeString(value); return -8; }
          hr = state.value->SetValue(value);
          SysFreeString(value); }
        break;
      case 3:
        if (!state.scroll || (deltaX == 0 && deltaY == 0) ||
            deltaX < -3 || deltaX > 3 || deltaY < -3 || deltaY > 3) return -6;
        if (!authorizeNow || authorizeNow() != 1) return -8;
        hr = state.scroll->Scroll(amount(deltaX), amount(deltaY));
        break;
      default: return -6;
    }
    return SUCCEEDED(hr) ? 1 : -7;
  } catch (...) { return -100; }
}
