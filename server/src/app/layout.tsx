import type { ReactNode } from "react";

export const metadata = {
  title: "append.page",
  description: "A place to write things that can't be silently deleted.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          margin: 0,
          padding: 0,
          background: "#fafafa",
          color: "#111",
        }}
      >
        {children}
      </body>
    </html>
  );
}
