package com.agenticfabworks.aicc.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** A fixed browser entry only; all controls and authentication stay in the existing web UI. */
public final class MainActivity extends Activity {
    private static final Uri CONTROL = Uri.parse("https://aicc.example.invalid/mobile.html");

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        int spacing = Math.round(20 * getResources().getDisplayMetrics().density);
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(spacing, spacing, spacing, spacing);
        scroll.addView(content);
        // Target 36 uses edge-to-edge. Keep controls outside system bars and the cutout.
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        TextView title = text(R.string.heading, 26);
        if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
        content.addView(title);
        content.addView(text(R.string.intro, 17));
        TextView address = text(R.string.address, 14);
        address.setTextIsSelectable(true);
        content.addView(address);
        TextView result = text(0, 16);
        result.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        Button open = new Button(this);
        open.setText(R.string.open_control);
        open.setOnClickListener(view -> {
            // Ignore incoming Intent data/extras. No arbitrary origin, OAuth callback or shell.
            Intent browser = new Intent(Intent.ACTION_VIEW, CONTROL);
            browser.addCategory(Intent.CATEGORY_BROWSABLE);
            try {
                startActivity(browser);
                result.setText("");
            } catch (ActivityNotFoundException unavailable) {
                result.setText(R.string.browser_missing);
            }
        });
        content.addView(open);
        Button update = new Button(this);
        update.setText("설치 안내 · 앱 업데이트");
        update.setOnClickListener(view -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://aicc.example.invalid/install.html")));
            } catch (ActivityNotFoundException unavailable) {
                result.setText(R.string.browser_missing);
            }
        });
        content.addView(update);
        content.addView(result);
        content.addView(text(R.string.pairing, 16));
        content.addView(text(R.string.limits, 16));
        setContentView(scroll);
        scroll.requestApplyInsets();
    }

    private TextView text(int resource, int size) {
        TextView view = new TextView(this);
        if (resource != 0) view.setText(resource);
        view.setTextSize(size);
        int gap = Math.round(16 * getResources().getDisplayMetrics().density);
        view.setPadding(0, 0, 0, gap);
        return view;
    }
}
