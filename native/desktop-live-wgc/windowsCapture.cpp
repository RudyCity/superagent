// SuperAgent Desktop Live - local exact-HWND Windows Graphics Capture helper.
// Build with MSVC and Windows SDK. No network, input injection, window picking,
// file screenshots, or desktop-wide fallback. Read-only opt-in helper process.
// A caller must pin the exact target through a native human approval first.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <wincrypt.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/base.h>
#include <algorithm>
#include <cmath>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
#include <cwctype>

using namespace winrt;
using namespace winrt::Windows::Data::Json;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

static int diagnosticsStage = 0;
static void require(bool ok) {
    if (!ok) throw std::runtime_error("CAPTURE_DENIED_STAGE_" + std::to_string(diagnosticsStage));
}

struct WindowScope {
    HWND hwnd{};
    DWORD pid{};
    std::wstring title;
    std::wstring application;
    RECT rect{};
    FILETIME birth{};
    HANDLE process{};

    WindowScope() {
        diagnosticsStage = 10;
        DWORD length = GetEnvironmentVariableW(L"SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET", nullptr, 0);
        require(length > 2 && length < 4096);
        std::wstring value(length, L'\0');
        require(GetEnvironmentVariableW(L"SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET", value.data(), length) > 0);
        value.resize(length - 1);
        auto json = JsonObject::Parse(value);
        diagnosticsStage = 11;
        auto hwndText = json.GetNamedString(L"nativeId");
        require(!hwndText.empty() && hwndText.size() < 22);
        uint64_t numeric = 0;
        for (auto c : hwndText) {
            require(c >= L'0' && c <= L'9');
            uint64_t next = numeric * 10u + static_cast<uint64_t>(c - L'0');
            require(next >= numeric);
            numeric = next;
        }
        hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(numeric));
        auto pidValue = json.GetNamedNumber(L"pid");
        require(pidValue > 0 && pidValue <= 0xffffffff && pidValue == static_cast<DWORD>(pidValue));
        pid = static_cast<DWORD>(pidValue);
        title = json.GetNamedString(L"title");
        application = json.GetNamedString(L"application");
        require(!title.empty() && title.size() <= 512 && !application.empty() && application.size() <= 256);
        auto bounds = json.GetNamedObject(L"bounds");
        auto field = [&](wchar_t const* name) {
            auto n = bounds.GetNamedNumber(name);
            require(n >= INT32_MIN && n <= INT32_MAX && n == static_cast<int32_t>(n));
            return static_cast<LONG>(n);
        };
        rect.left = field(L"x");
        rect.top = field(L"y");
        rect.right = rect.left + field(L"width");
        rect.bottom = rect.top + field(L"height");
        require(rect.right > rect.left && rect.bottom > rect.top &&
                rect.right - rect.left <= 8192 && rect.bottom - rect.top <= 8192);
        diagnosticsStage = 12;
        process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        require(process != nullptr);
        FILETIME exit{}, kernel{}, user{};
        require(GetProcessTimes(process, &birth, &exit, &kernel, &user));
        verify();
    }
    ~WindowScope() { if (process) CloseHandle(process); }

    void verify() const {
        diagnosticsStage = 20;
        // Fail closed on lock screen, UAC secure desktop or unknown session.
        HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
        require(desktop != nullptr);
        wchar_t desktopName[128]{};
        DWORD needed = 0;
        bool normal = GetUserObjectInformationW(desktop, UOI_NAME, desktopName,
                       sizeof desktopName, &needed) && wcscmp(desktopName, L"Default") == 0;
        CloseDesktop(desktop);
        require(normal);
        diagnosticsStage = 21;
        require(IsWindow(hwnd) && IsWindowVisible(hwnd) && !IsIconic(hwnd));
        require(GetAncestor(hwnd, GA_ROOT) == hwnd);
        DWORD actual = 0;
        GetWindowThreadProcessId(hwnd, &actual);
        require(actual == pid);
        diagnosticsStage = 22;
        DWORD classSize = 256;
        wchar_t clazz[256]{};
        GetClassNameW(hwnd, clazz, classSize);
        require(wcscmp(clazz,L"Shell_TrayWnd") && wcscmp(clazz,L"Progman") && wcscmp(clazz,L"WorkerW"));

        FILETIME creation{}, exit{}, kernel{}, user{};
        require(GetProcessTimes(process, &creation, &exit, &kernel, &user));
        require(creation.dwLowDateTime == birth.dwLowDateTime && creation.dwHighDateTime == birth.dwHighDateTime);
        wchar_t exeName[1024]{};
        DWORD exeLength = 1024;
        require(QueryFullProcessImageNameW(process, 0, exeName, &exeLength));
        std::wstring name(exeName, exeLength);
        auto slash = name.find_last_of(L"\\/");
        if (slash != std::wstring::npos) name = name.substr(slash+1);
        auto dot = name.find_last_of(L".");
        if (dot != std::wstring::npos) name = name.substr(0,dot);
        require(_wcsicmp(name.c_str(),application.c_str())==0);
        diagnosticsStage = 23;
        DWORD affinity = 0;
        require(GetWindowDisplayAffinity(hwnd, &affinity) && affinity == WDA_NONE);
        diagnosticsStage = 24;
        BOOL cloaked = FALSE;
        require(SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof cloaked)) && !cloaked);
        RECT bounds{};
        require(GetWindowRect(hwnd,&bounds));
        require(bounds.left == rect.left && bounds.top == rect.top &&
                bounds.right == rect.right && bounds.bottom == rect.bottom);
        diagnosticsStage = 25;
        int length = GetWindowTextLengthW(hwnd);
        require(length > 0 && length < 1024);
        std::wstring text(length+1,L'\0');
        int copied = GetWindowTextW(hwnd, text.data(), static_cast<int>(text.size()));
        require(copied == length);
        text.resize(copied);
        require(text == title);
        diagnosticsStage = 26;
    }
};

static std::vector<uint8_t> imageToPng(uint8_t const* bytes, uint32_t width, uint32_t height, uint32_t stride) {
    require(width > 0 && width <= 8192 && height > 0 && height <= 8192 && width*uint64_t(height) <= 16000000);
    require(stride >= width*4 && stride*uint64_t(height) <= UINT32_MAX);
    winrt::com_ptr<IWICImagingFactory> factory;
    check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(factory.put())));
    winrt::com_ptr<IStream> stream;
    check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
    winrt::com_ptr<IWICBitmapEncoder> encoder;
    check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()));
    check_hresult(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache));
    winrt::com_ptr<IWICBitmapFrameEncode> frame;
    winrt::com_ptr<IPropertyBag2> properties;
    check_hresult(encoder->CreateNewFrame(frame.put(), properties.put()));
    check_hresult(frame->Initialize(properties.get()));
    check_hresult(frame->SetSize(width,height));
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    check_hresult(frame->SetPixelFormat(&format));
    require(format == GUID_WICPixelFormat32bppBGRA);
    check_hresult(frame->WritePixels(height,stride,stride*height,const_cast<BYTE*>(bytes)));
    check_hresult(frame->Commit());
    check_hresult(encoder->Commit());
    HGLOBAL memory{};
    check_hresult(GetHGlobalFromStream(stream.get(), &memory));
    STATSTG contents{};
    check_hresult(stream->Stat(&contents, STATFLAG_NONAME));
    auto exactLength = contents.cbSize.QuadPart;
    SIZE_T length = GlobalSize(memory);
    // GlobalSize may report rounded capacity rather than committed PNG
    // bytes. Never copy uninitialized padding into a preview response.
    require(exactLength >= 24 && exactLength <= 8*1024*1024 &&
            exactLength <= length);
    auto ptr = static_cast<uint8_t const*>(GlobalLock(memory));
    require(ptr != nullptr);
    std::vector<uint8_t> encoded(ptr, ptr+static_cast<size_t>(exactLength));
    GlobalUnlock(memory);
    return encoded;
}

static std::string base64(std::vector<uint8_t> const& bytes) {
    DWORD size = 0;
    require(CryptBinaryToStringA(bytes.data(),static_cast<DWORD>(bytes.size()),
        CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,nullptr,&size) != 0);
    std::string out(size,'\0');
    require(CryptBinaryToStringA(bytes.data(),static_cast<DWORD>(bytes.size()),
        CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,out.data(),&size) != 0);
    out.resize(size);
    while (!out.empty() && out.back() == '\0') out.pop_back();
    return out;
}

class WgcWindowCapture {
    WindowScope const& scope;
    winrt::com_ptr<ID3D11Device> gpu;
    winrt::com_ptr<ID3D11DeviceContext> context;
    Direct3D11CaptureFramePool pool{nullptr};
    GraphicsCaptureSession session{nullptr};
    uint32_t expectedWidth = 0;
    uint32_t expectedHeight = 0;
    std::mutex mutex;
    std::condition_variable updated;
    Direct3D11CaptureFrame frame{nullptr};
    bool destroyed = false;
    std::vector<uint8_t> lastVerifiedPng;
    winrt::event_token arrived{};
    bool arrivedAttached = false;

public:
    explicit WgcWindowCapture(WindowScope const& target) : scope(target) {
        diagnosticsStage = 30;
        require(GraphicsCaptureSession::IsSupported());
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        D3D_FEATURE_LEVEL level{};
        check_hresult(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,
            flags,nullptr,0,D3D11_SDK_VERSION,gpu.put(),&level,context.put()));
        auto dxgi = gpu.as<IDXGIDevice>();
        winrt::com_ptr<IInspectable> wrapped;
        check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), wrapped.put()));
        auto device = wrapped.as<IDirect3DDevice>();
        diagnosticsStage = 31;
        auto factory = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
        GraphicsCaptureItem item{nullptr};
        check_hresult(factory->CreateForWindow(scope.hwnd, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
        diagnosticsStage = 32;
        // WGC reports the compositor's content bounds, which may omit
        // invisible borders included by GetWindowRect. Only accept a
        // tightly proportional variant of the operator-approved HWND.
        const auto capturedSize = item.Size();
        const auto outerWidth = scope.rect.right-scope.rect.left;
        const auto outerHeight = scope.rect.bottom-scope.rect.top;
        const double horizontal = double(capturedSize.Width) / outerWidth;
        const double vertical = double(capturedSize.Height) / outerHeight;
        require(capturedSize.Width > 0 && capturedSize.Height > 0 &&
                capturedSize.Width <= 8192 && capturedSize.Height <= 8192 &&
                uint64_t(capturedSize.Width) * capturedSize.Height <= 16000000 &&
                horizontal >= 0.90 && horizontal <= 1.10 &&
                vertical >= 0.90 && vertical <= 1.10 &&
                std::abs(horizontal - vertical) <= 0.08);
        expectedWidth = static_cast<uint32_t>(capturedSize.Width);
        expectedHeight = static_cast<uint32_t>(capturedSize.Height);
        diagnosticsStage = 33;
        pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            device, DirectXPixelFormat::B8G8R8A8UIntNormalized,2,item.Size());
        arrived = pool.FrameArrived([this](Direct3D11CaptureFramePool const& sender, auto const&) {
            std::lock_guard<std::mutex> hold(mutex);
            if (destroyed || frame) return;
            try { frame = sender.TryGetNextFrame(); }
            catch (...) { destroyed = true; }
            updated.notify_all();
        });
        arrivedAttached = true;
        diagnosticsStage = 34;
        try {
            session = pool.CreateCaptureSession(item);
            session.IsCursorCaptureEnabled(false);
            session.StartCapture();
        } catch (...) {
            // A throwing constructor does not run this class's destructor.
            // Deregister the callback before it could observe a dead "this".
            {
                std::lock_guard<std::mutex> hold(mutex);
                destroyed = true;
            }
            if (pool && arrivedAttached) {
                pool.FrameArrived(arrived);
                arrivedAttached = false;
            }
            if (session) session.Close();
            if (pool) pool.Close();
            throw;
        }
    }
    ~WgcWindowCapture() {
        {
            std::lock_guard<std::mutex> hold(mutex);
            destroyed = true;
            frame = nullptr;
        }
        try {
            if (pool && arrivedAttached) {
                pool.FrameArrived(arrived);
                arrivedAttached = false;
            }
            if (session) session.Close();
            if (pool) pool.Close();
        } catch (...) {
            // No C++ exception may escape native destructor during revocation.
        }
    }

    std::vector<uint8_t> capture() {
        scope.verify();
        Direct3D11CaptureFrame current{nullptr};
        {
            std::unique_lock<std::mutex> hold(mutex);
            // WGC emits on compositor changes, not on every viewer poll.
            // A static window is legitimate: reuse its last verified pixels
            // after a short deadline, but ALWAYS verify the HWND first/last.
            const auto deadline = lastVerifiedPng.empty()
                ? std::chrono::seconds(3) : std::chrono::milliseconds(220);
            updated.wait_for(hold,deadline,[&] {return bool(frame) || destroyed;});
            require(!destroyed);
            if (!frame) {
                require(!lastVerifiedPng.empty());
                scope.verify();
                return lastVerifiedPng;
            }
            current = frame;
            frame = nullptr;
        }
        scope.verify();
        auto content = current.ContentSize();
        // Frame content is defined in WGC's compositor bounds, not the
        // slightly larger Win32 GetWindowRect outer bounds.
        require(content.Width == expectedWidth && content.Height == expectedHeight);
        auto access = current.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        winrt::com_ptr<ID3D11Texture2D> texture;
        check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D),texture.put_void()));
        D3D11_TEXTURE2D_DESC description{};
        texture->GetDesc(&description);
        require(description.Width == uint32_t(content.Width) &&
                description.Height == uint32_t(content.Height) &&
                description.Format == DXGI_FORMAT_B8G8R8A8_UNORM);
        description.Usage = D3D11_USAGE_STAGING;
        description.BindFlags = 0;
        description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        description.MiscFlags = 0;
        winrt::com_ptr<ID3D11Texture2D> staging;
        check_hresult(gpu->CreateTexture2D(&description,nullptr,staging.put()));
        context->CopyResource(staging.get(),texture.get());
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check_hresult(context->Map(staging.get(),0,D3D11_MAP_READ,0,&mapped));
        try {
            auto result = imageToPng(static_cast<uint8_t const*>(mapped.pData),
                description.Width,description.Height,mapped.RowPitch);
            context->Unmap(staging.get(),0);
            scope.verify();
            lastVerifiedPng = result;
            return result;
        } catch (...) {
            context->Unmap(staging.get(),0);
            throw;
        }
    }
};

static void writeFrame(WindowScope const& scope, std::vector<uint8_t> const& png) {
    JsonObject bounds;
    bounds.Insert(L"x", JsonValue::CreateNumberValue(scope.rect.left));
    bounds.Insert(L"y", JsonValue::CreateNumberValue(scope.rect.top));
    bounds.Insert(L"width",JsonValue::CreateNumberValue(scope.rect.right-scope.rect.left));
    bounds.Insert(L"height",JsonValue::CreateNumberValue(scope.rect.bottom-scope.rect.top));
    JsonObject window;
    window.Insert(L"pid",JsonValue::CreateNumberValue(scope.pid));
    window.Insert(L"nativeId",JsonValue::CreateStringValue(to_hstring(reinterpret_cast<uintptr_t>(scope.hwnd))));
    window.Insert(L"title",JsonValue::CreateStringValue(scope.title));
    window.Insert(L"active",JsonValue::CreateBooleanValue(GetForegroundWindow()==scope.hwnd));
    window.Insert(L"bounds",bounds);
    JsonObject output;
    output.Insert(L"type",JsonValue::CreateStringValue(L"frame"));
    output.Insert(L"window",window);
    output.Insert(L"png",JsonValue::CreateStringValue(to_hstring(base64(png))));
    std::cout << winrt::to_string(output.Stringify()) << '\n' << std::flush;
}

int main() {
    // Avoid any debug output on stdout; all stdout must be bounded protocol.
    try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        // GetWindowRect must use the same unvirtualized DPI context as the
        // approved native Core discovery, especially on 125–200% monitors.
        require(SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != nullptr);
        WindowScope scope;
        WgcWindowCapture capture(scope);
        diagnosticsStage = 40;
        std::cout << R"({"type":"ready"})" << '\n' << std::flush;
        std::string command;
        auto until = std::chrono::steady_clock::now()+std::chrono::minutes(5);
        while (std::getline(std::cin,command)) {
            if (command=="close") break;
            if (command!="capture" || std::chrono::steady_clock::now()>until) break;
            try {
                writeFrame(scope,capture.capture());
            } catch (std::exception const& error) {
                if (GetEnvironmentVariableW(L"SUPERAGENT_WGC_DIAG", nullptr, 0))
                    std::cerr << "WGC_FRAME_DIAGNOSTIC_STAGE_" << diagnosticsStage << ": "
                              << error.what() << std::endl;
                std::cout << R"({"type":"denied"})" << '\n' << std::flush;
                break;
            } catch (...) {
                std::cout << R"({"type":"denied"})" << '\n' << std::flush;
                break;
            }
        }
        return 0;
    } catch (std::exception const& error) {
        // Diagnostic reason is permitted only in disposable host tests.
        // Normal Core must never log window metadata or screenshot content.
        if (GetEnvironmentVariableW(L"SUPERAGENT_WGC_DIAG", nullptr, 0))
            std::cerr << "WGC_DIAGNOSTIC: " << error.what() << std::endl;
        return 2;
    } catch (...) {
        return 2;
    }
}
