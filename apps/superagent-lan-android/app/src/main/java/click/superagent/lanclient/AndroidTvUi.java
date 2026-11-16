package click.superagent.lanclient;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

/** One Android binary with a dedicated lean-back navigation layout on televisions. */
final class AndroidTvUi {
    private AndroidTvUi() {}

    static boolean isTv(Context context) {
        UiModeManager mode = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        return (mode != null && mode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }

    static LinearLayout navigation(Activity activity, boolean tv) {
        LinearLayout nav = AndroidUiKit.bottomBar(activity);
        if (tv) {
            nav.setOrientation(LinearLayout.VERTICAL);
            nav.setPadding(AndroidUiKit.dp(activity, 12), AndroidUiKit.dp(activity, 24),
                    AndroidUiKit.dp(activity, 12), AndroidUiKit.dp(activity, 12));
        }
        return nav;
    }

    static void addTab(Activity activity, LinearLayout nav, Button tab, boolean tv) {
        LinearLayout.LayoutParams params = tv
                ? new LinearLayout.LayoutParams(-1, AndroidUiKit.dp(activity, 66))
                : new LinearLayout.LayoutParams(0, AndroidUiKit.dp(activity, 46), 1f);
        if (!tv) {
            params.setMargins(AndroidUiKit.dp(activity, 3), 0, AndroidUiKit.dp(activity, 3), 0);
        }
        nav.addView(tab, params);
    }

    static void attach(Activity activity, LinearLayout root, FrameLayout pageHost,
                       LinearLayout nav, boolean tv) {
        if (!tv) {
            root.addView(pageHost, new LinearLayout.LayoutParams(-1, 0, 1f));
            android.view.View divider = new android.view.View(activity);
            divider.setBackgroundColor(AndroidUiKit.LINE);
            root.addView(divider, new LinearLayout.LayoutParams(-1, AndroidUiKit.dp(activity, 1)));
            root.addView(nav);
            return;
        }
        LinearLayout workspace = new LinearLayout(activity);
        workspace.setOrientation(LinearLayout.HORIZONTAL);
        workspace.addView(nav, new LinearLayout.LayoutParams(AndroidUiKit.dp(activity, 206), -1));
        android.view.View divider = new android.view.View(activity);
        divider.setBackgroundColor(AndroidUiKit.LINE);
        workspace.addView(divider, new LinearLayout.LayoutParams(AndroidUiKit.dp(activity, 1), -1));
        workspace.addView(pageHost, new LinearLayout.LayoutParams(0, -1, 1f));
        root.addView(workspace, new LinearLayout.LayoutParams(-1, 0, 1f));
    }
}
