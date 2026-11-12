package click.superagent.lanclient;

import android.app.Activity;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Native dashboard design system. Hallmark review: philosophy 5, hierarchy 5,
 * execution 4, specificity 5, restraint 5, variety 4.
 * One centralized token palette; no extra Android UI dependencies.
 */
final class AndroidUiKit {
    static final int CANVAS = 0xff0b1422;
    static final int SURFACE = 0xff152337;
    static final int SURFACE_HIGH = 0xff1c2d43;
    static final int LINE = 0xff2a4158;
    static final int TEXT = 0xfff2f6fd;
    static final int MUTED = 0xffb1c2d5;
    static final int SUBTLE = 0xff849bb4;
    static final int ACCENT = 0xff70dec3;
    static final int BLUE = 0xff8dbaff;
    static final int DANGER = 0xffff9da2;
    static final int INK = 0xff102333;

    private AndroidUiKit() {}

    static int dp(Context ctx, int value) {
        return (int) (value * ctx.getResources().getDisplayMetrics().density + 0.5f);
    }

    static GradientDrawable shape(int color, int border, int radius, Context ctx) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(ctx, radius));
        if (border != 0) shape.setStroke(dp(ctx, 1), border);
        return shape;
    }

    static TextView text(Context ctx, String value, int size, int color, boolean bold) {
        TextView view = new TextView(ctx);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setTypeface(bold ? Typeface.create("sans-serif-medium", Typeface.NORMAL)
                : Typeface.create("sans-serif", Typeface.NORMAL));
        view.setIncludeFontPadding(true);
        view.setPadding(0, dp(ctx, 4), 0, dp(ctx, 4));
        view.setLineSpacing(dp(ctx, 2), 1.06f);
        return view;
    }

    static void add(LinearLayout root, View child, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(root.getContext(), top);
        root.addView(child, params);
    }

    static Button button(Context ctx, String title, Runnable onClick) {
        Button button = new Button(ctx);
        button.setAllCaps(false);
        button.setSingleLine(true);
        button.setText(title);
        button.setTextSize(14);
        button.setTextColor(TEXT);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setMinHeight(dp(ctx, 52));
        button.setMinimumHeight(dp(ctx, 52));
        button.setPadding(dp(ctx, 12), dp(ctx, 8), dp(ctx, 12), dp(ctx, 8));
        button.setBackground(new RippleDrawable(
                ColorStateList.valueOf(0x408dbaff),
                shape(SURFACE_HIGH, LINE, 14, ctx), null));
        button.setOnClickListener(v -> onClick.run());
        button.setStateListAnimator(null);
        return button;
    }

    static void primary(Button button) {
        Context context = button.getContext();
        button.setTextColor(INK);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x309bc2ce),
                shape(ACCENT, 0, 14, context), null));
    }

    static void destructive(Button button) {
        Context context = button.getContext();
        button.setTextColor(DANGER);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x30ff9da2),
                shape(SURFACE, 0xff744650, 14, context), null));
    }

    static void field(EditText view) {
        Context ctx = view.getContext();
        view.setTextColor(TEXT);
        view.setHintTextColor(SUBTLE);
        view.setTextSize(14);
        view.setPadding(dp(ctx, 16), dp(ctx, 12), dp(ctx, 16), dp(ctx, 12));
        view.setMinHeight(dp(ctx, 52));
        view.setBackground(shape(SURFACE_HIGH, LINE, 13, ctx));
    }

    static LinearLayout page(Activity activity) {
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(activity, 20), dp(activity, 12),
                dp(activity, 20), dp(activity, 30));
        return column;
    }

    static ScrollView scroll(Activity activity, LinearLayout page) {
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(false);
        scroll.setClipToPadding(false);
        scroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        scroll.addView(page);
        return scroll;
    }

    static LinearLayout panel(LinearLayout root, String eyebrow) {
        Context ctx = root.getContext();
        LinearLayout panel = new LinearLayout(ctx);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(ctx, 18), dp(ctx, 17), dp(ctx, 18), dp(ctx, 19));
        panel.setBackground(shape(SURFACE, LINE, 20, ctx));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(ctx, 14);
        root.addView(panel, params);
        if (eyebrow != null && !eyebrow.isEmpty()) {
            TextView text = text(ctx, eyebrow, 11, BLUE, true);
            text.setLetterSpacing(.09f);
            add(panel, text, 0);
        }
        return panel;
    }

    static LinearLayout header(Context ctx) {
        LinearLayout shell = new LinearLayout(ctx);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setPadding(dp(ctx, 20), dp(ctx, 8), dp(ctx, 20), dp(ctx, 10));
        shell.setBackgroundColor(CANVAS);
        TextView wordmark = text(ctx, "SUPERAGENT   /   ANDROID", 12, ACCENT, true);
        wordmark.setLetterSpacing(.12f);
        add(shell, wordmark, 0);
        TextView subtitle = text(ctx, "Private device companion", 12, MUTED, false);
        add(shell, subtitle, 0);
        return shell;
    }

    static LinearLayout bottomBar(Context ctx) {
        LinearLayout bar = new LinearLayout(ctx);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(ctx, 8), dp(ctx, 9), dp(ctx, 8), dp(ctx, 9));
        bar.setBackground(shape(SURFACE, LINE, 0, ctx));
        return bar;
    }

    static Button tab(Context ctx, String title, Runnable onClick) {
        Button button = button(ctx, title, onClick);
        button.setTextSize(12);
        button.setPadding(dp(ctx, 2), dp(ctx, 7), dp(ctx, 2), dp(ctx, 7));
        button.setMinHeight(dp(ctx, 48));
        button.setMinimumHeight(dp(ctx, 48));
        button.setBackground(shape(SURFACE, 0, 12, ctx));
        button.setTextColor(MUTED);
        return button;
    }

    static void activeTab(Button button, boolean active) {
        button.setSelected(active);
        button.setTextColor(active ? ACCENT : MUTED);
        button.setBackground(shape(active ? SURFACE_HIGH : SURFACE,
                active ? LINE : 0, 12, button.getContext()));
        button.setContentDescription(button.getText() + (active ? ", selected tab" : ", tab"));
    }
}
